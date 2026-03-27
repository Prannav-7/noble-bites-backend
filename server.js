import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import { db, auth, storage } from './firebaseConfig.js';

const app = express();
const PORT = process.env.PORT || 5000;

// Razorpay is initialized lazily inside route handlers
// to prevent server crash if env vars are missing on first deploy
const getRazorpay = () => {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        throw new Error('Razorpay keys not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET env vars.');
    }
    return new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
};

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increased limit for base64 images
app.use(express.urlencoded({ limit: '50mb', extended: true }));

import { updateDocument, deleteDocument } from './firebaseOperations.js';
import { sendOrderConfirmationEmail, sendLowStockAlert } from './emailService.js';
import { sendLowStockWhatsApp } from './whatsappService.js';


// ============================================
// SPECIFIC ORDER ROUTES (must come before /api/data/:collection)
// ============================================

// Track order by ID
app.get('/api/orders/track/:id', async (req, res) => {
    try {
        const { id } = req.params;

        console.log('========== ORDER TRACKING REQUEST ==========');
        console.log('Tracking Order ID:', id);

        const { doc: docFunc, getDoc } = await import('firebase/firestore');
        const orderRef = docFunc(db, 'orders', id);
        const orderSnapshot = await getDoc(orderRef);

        if (!orderSnapshot.exists()) {
            console.log('Order not found');
            return res.status(404).json({
                success: false,
                error: 'Order not found. Please check your order ID and try again.'
            });
        }

        const orderData = orderSnapshot.data();
        console.log('Order found:', orderData);
        console.log('==========================================');

        res.json({
            success: true,
            order: {
                ...orderData,
                docId: orderSnapshot.id
            }
        });
    } catch (error) {
        console.error('Error tracking order:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Update order (including status)
app.put('/api/orders/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = req.body;

        console.log('========== ORDER UPDATE REQUEST ==========');
        console.log('Order ID:', id);
        console.log('Update Data:', JSON.stringify(updateData, null, 2));

        const result = await updateDocument('orders', id, updateData);

        console.log('Update Result:', result);
        console.log('==========================================');

        if (result.success) {
            res.json({ success: true, message: 'Order updated successfully' });
        } else {
            res.status(500).json({ success: false, error: result.error });
        }
    } catch (error) {
        console.error('Error updating order:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Cancel Order Route (with stock restoration)
app.post('/api/orders/:id/cancel', async (req, res) => {
    try {
        const { id } = req.params;
        const { getDoc, doc: docFunc, updateDoc, query, collection: firestoreCollection, where, getDocs } = await import('firebase/firestore');

        console.log('========== ORDER CANCELLATION REQUEST ==========');
        console.log('Order ID:', id);

        // 1. Get the order details
        const orderRef = docFunc(db, 'orders', id);
        const orderSnapshot = await getDoc(orderRef);

        if (!orderSnapshot.exists()) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }

        const orderData = orderSnapshot.data();

        // Check if order can be cancelled
        if (orderData.status === 'Delivered' || orderData.status === 'Cancelled') {
            return res.status(400).json({
                success: false,
                error: `Order cannot be cancelled because it is already ${orderData.status}`
            });
        }

        // 2. Update order status to 'Cancelled'
        await updateDoc(orderRef, {
            status: 'Cancelled',
            cancelledAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });

        // 3. Restore stock for each item
        if (orderData.items && orderData.items.length > 0) {
            for (const item of orderData.items) {
                console.log(`Restoring stock for product ID: ${item.id}`);

                let targetProductDoc = null;

                // Try numeric ID
                const numericId = parseInt(item.id);
                if (!isNaN(numericId)) {
                    const productsQuery = query(
                        firestoreCollection(db, 'products'),
                        where('id', '==', numericId)
                    );
                    const qSnapshot = await getDocs(productsQuery);
                    if (!qSnapshot.empty) targetProductDoc = qSnapshot.docs[0];
                }

                // Try string ID
                if (!targetProductDoc) {
                    const stringQuery = query(
                        firestoreCollection(db, 'products'),
                        where('id', '==', String(item.id))
                    );
                    const sSnapshot = await getDocs(stringQuery);
                    if (!sSnapshot.empty) targetProductDoc = sSnapshot.docs[0];
                }

                // Try direct doc ID
                if (!targetProductDoc && String(item.id).length > 5) {
                    try {
                        const directRef = docFunc(db, 'products', String(item.id));
                        const directSnap = await getDoc(directRef);
                        if (directSnap.exists()) targetProductDoc = directSnap;
                    } catch (e) { }
                }

                if (targetProductDoc) {
                    const productData = targetProductDoc.data();
                    const currentStock = Number(productData.available) || 0;

                    // Get product unit
                    let productUnit = productData.unit;
                    if (!productUnit) {
                        const category = (productData.category || '').toLowerCase();
                        productUnit = category.includes('oil') ? 'L' : 'kg';
                    }

                    // Calculate quantity to restore
                    let quantityToRestore = Number(item.quantity) || 0;

                    if (item.size) {
                        const sizeMatch = String(item.size).match(/^([\d.]+)\s*(kg|gm|g|l|ml)$/i);
                        if (sizeMatch) {
                            const sizeValue = parseFloat(sizeMatch[1]);
                            const sizeUnit = sizeMatch[2].toLowerCase();
                            const productUnitLower = productUnit.toLowerCase();

                            if (productUnitLower === 'kg') {
                                if (sizeUnit === 'gm' || sizeUnit === 'g') quantityToRestore = item.quantity * (sizeValue / 1000);
                                else if (sizeUnit === 'kg') quantityToRestore = item.quantity * sizeValue;
                            } else if (productUnitLower === 'gm' || productUnitLower === 'g') {
                                if (sizeUnit === 'kg') quantityToRestore = item.quantity * (sizeValue * 1000);
                                else if (sizeUnit === 'gm' || sizeUnit === 'g') quantityToRestore = item.quantity * sizeValue;
                            } else if (productUnitLower === 'l') {
                                if (sizeUnit === 'ml') quantityToRestore = item.quantity * (sizeValue / 1000);
                                else if (sizeUnit === 'l') quantityToRestore = item.quantity * sizeValue;
                            } else if (productUnitLower === 'ml') {
                                if (sizeUnit === 'l') quantityToRestore = item.quantity * (sizeValue * 1000);
                                else if (sizeUnit === 'ml') quantityToRestore = item.quantity * sizeValue;
                            }
                        }
                    }

                    const newStock = currentStock + quantityToRestore;
                    const productRef = docFunc(db, 'products', targetProductDoc.id);

                    await updateDoc(productRef, {
                        available: newStock,
                        inStock: newStock > 0,
                        updatedAt: new Date().toISOString()
                    });

                    console.log(`Restored stock for ${productData.name}: ${currentStock} -> ${newStock}`);
                }
            }
        }

        console.log('Order cancelled and stock restored successfully');
        console.log('==========================================');

        res.json({ success: true, message: 'Order cancelled successfully' });
    } catch (error) {
        console.error('Error cancelling order:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Test route
app.get('/', (req, res) => {
    res.json({ message: 'Backend server is running with Firebase!' });
});

// Health check endpoint for mobile testing
app.get('/health', (req, res) => {
    res.json({ status: 'Backend working 🚀' });
});

/**
 * Helper to check stock and notify if low
 */
const checkAndNotifyLowStock = async (productData, updatedStock, unit, size = 'N/A') => {
    const LOW_STOCK_THRESHOLD = 5;
    const currentStockValue = Number(updatedStock);

    console.log(`Inventory Check: ${productData.name} - Stock: ${currentStockValue} (Threshold: ${LOW_STOCK_THRESHOLD})`);

    if (currentStockValue <= LOW_STOCK_THRESHOLD) {
        console.log(`⚠️ TRIGGERING LOW STOCK ALERT: ${productData.name}`);

        const alertData = {
            name: productData.name,
            stock: currentStockValue,
            unit: unit || 'units',
            size: size
        };

        // Send notifications independently using Promise.allSettled
        // This ensures if WhatsApp fails (e.g. invalid token), Email still sends, and vice versa.
        const results = await Promise.allSettled([
            sendLowStockAlert(alertData),
            sendLowStockWhatsApp(alertData)
        ]);

        results.forEach((result, index) => {
            const type = index === 0 ? 'Email' : 'WhatsApp';
            if (result.status === 'fulfilled') {
                console.log(`✅ ${type} Alert Sent:`, result.value);
            } else {
                console.error(`❌ ${type} Alert Failed:`, result.reason);
            }
        });

        return true;
    }
    return false;
};

// Test Alert Endpoint
app.get('/api/test-alert', async (req, res) => {
    try {
        console.log('--- TRIGGERING TEST ALERT ---');
        const testData = {
            name: 'TEST PRODUCT (FreshFlow)',
            stock: 2,
            unit: 'kg',
            size: '500g'
        };

        await sendLowStockAlert(testData);
        await sendLowStockWhatsApp(testData);

        res.json({ success: true, message: 'Test notifications sent! Check your email and terminal.' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// GENERIC DATA ROUTES
// ============================================

// Example Firebase Firestore route - Get all documents from a collection
app.get('/api/data/:collection', async (req, res) => {
    try {
        const { collection } = req.params;
        const { getDocs, collection: firestoreCollection } = await import('firebase/firestore');

        const querySnapshot = await getDocs(firestoreCollection(db, collection));
        const data = [];

        querySnapshot.forEach((doc) => {
            // Store Firestore document ID separately to avoid conflicts with product's numeric id
            const docData = doc.data();
            data.push({
                ...docData,
                docId: doc.id, // Firestore document ID for updates/deletes
                // Keep the product's numeric id if it exists, otherwise use doc.id
                id: docData.id !== undefined ? docData.id : doc.id
            });
        });

        res.json({ success: true, data });
    } catch (error) {
        console.error('Error fetching data:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Example Firebase Firestore route - Add document to a collection
app.post('/api/data/:collection', async (req, res) => {
    try {
        const { collection } = req.params;
        const data = req.body;
        const { addDoc, collection: firestoreCollection } = await import('firebase/firestore');

        const docRef = await addDoc(firestoreCollection(db, collection), data);

        res.json({
            success: true,
            message: 'Document added successfully',
            id: docRef.id
        });
    } catch (error) {
        console.error('Error adding document:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// EMAIL NOTIFICATION ROUTES
// ============================================

// Send order confirmation email
app.post('/api/email/order-confirmation', async (req, res) => {
    try {
        const orderDetails = req.body;

        console.log('========== EMAIL NOTIFICATION REQUEST ==========');
        console.log('Sending order confirmation to:', orderDetails.customerEmail);

        // Validate required fields
        if (!orderDetails.customerEmail || !orderDetails.orderId) {
            return res.status(400).json({
                success: false,
                error: 'Customer email and order ID are required'
            });
        }

        // Send email
        const result = await sendOrderConfirmationEmail(orderDetails);

        console.log('Email Result:', result);
        console.log('================================================');

        if (result.success) {
            res.json({
                success: true,
                message: 'Order confirmation email sent successfully',
                messageId: result.messageId
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error || 'Failed to send email'
            });
        }
    } catch (error) {
        console.error('Error sending email:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// AUTHENTICATION ROUTES
// ============================================

import { signUp, signIn, googleSignIn, signOutUser, getUserData, updateUserProfile, changeUserPassword } from './authRoutes.js';

// Sign Up - Create new user
app.post('/api/auth/signup', async (req, res) => {
    try {
        console.log('--- INCOMING SIGNUP REQUEST ---');
        console.log('Body:', JSON.stringify(req.body, null, 2));
        const { email, password, displayName } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                error: 'Email and password are required'
            });
        }

        const result = await signUp(email, password, displayName);

        if (result.success) {
            res.status(201).json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Sign In - Login user
app.post('/api/auth/signin', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                error: 'Email and password are required'
            });
        }

        const result = await signIn(email, password);

        if (result.success) {
            res.json(result);
        } else {
            res.status(401).json(result);
        }
    } catch (error) {
        console.error('Signin error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Google Sign In - Setup/Sync user
app.post('/api/auth/google', async (req, res) => {
    try {
        const userData = req.body;

        if (!userData || !userData.uid) {
            return res.status(400).json({
                success: false,
                error: 'User data with UID is required'
            });
        }

        const result = await googleSignIn(userData);

        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        console.error('Google auth error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Sign Out - Logout user
app.post('/api/auth/signout', async (req, res) => {
    try {
        const result = await signOutUser();
        res.json(result);
    } catch (error) {
        console.error('Signout error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get User Data
app.get('/api/auth/user/:uid', async (req, res) => {
    try {
        const { uid } = req.params;
        const result = await getUserData(uid);

        if (result.success) {
            res.json(result);
        } else {
            res.status(404).json(result);
        }
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Update User Profile
app.put('/api/auth/user/:uid', async (req, res) => {
    try {
        const { uid } = req.params;
        const updates = req.body;

        // Remove fields that shouldn't be updated
        delete updates.uid;
        delete updates.email;
        delete updates.createdAt;

        const result = await updateUserProfile(uid, updates);

        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Change Password
app.post('/api/auth/change-password', async (req, res) => {
    try {
        const { email, currentPassword, newPassword } = req.body;

        if (!email || !currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                error: 'Email, current password, and new password are required'
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                error: 'New password must be at least 6 characters long'
            });
        }

        const result = await changeUserPassword(email, currentPassword, newPassword);

        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});


// Admin Promotion Route - Set role to admin for an email
app.post('/api/auth/promote-admin', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, error: 'Email is required' });

        const { query, collection: firestoreCollection, where, getDocs, updateDoc, doc: docFunc } = await import('firebase/firestore');
        const q = query(firestoreCollection(db, 'users'), where('email', '==', email));
        const snapshot = await getDocs(q);

        if (snapshot.empty) {
            return res.status(404).json({ success: false, error: 'User not found in Firestore. Please login once first.' });
        }

        const userDoc = snapshot.docs[0];
        await updateDoc(docFunc(db, 'users', userDoc.id), {
            role: 'admin',
            updatedAt: new Date().toISOString()
        });

        res.json({ success: true, message: `User ${email} promoted to Admin successfully.` });
    } catch (error) {
        console.error('Promotion error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Purge User Route - Delete user from Firestore (to fix "past history" issues)
app.post('/api/auth/purge-user', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ success: false, error: 'Email is required' });

        const { query, collection: firestoreCollection, where, getDocs, deleteDoc, doc: docFunc } = await import('firebase/firestore');
        const q = query(firestoreCollection(db, 'users'), where('email', '==', email));
        const snapshot = await getDocs(q);

        if (snapshot.empty) {
            return res.status(404).json({ success: false, error: 'User not found in Firestore.' });
        }

        const deletePromises = snapshot.docs.map(doc => deleteDoc(docFunc(db, 'users', doc.id)));
        await Promise.all(deletePromises);

        res.json({ success: true, message: `User ${email} removed from Firestore. They can now register fresh.` });
    } catch (error) {
        console.error('Purge error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});


// ============================================
// PRODUCT MANAGEMENT ROUTES
// ============================================

import { getDocumentById } from './firebaseOperations.js';
import { uploadFile } from './firebaseOperations.js';
import multer from 'multer';

// Setup multer for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// Update product (including stock)
app.put('/api/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = req.body;

        console.log('========== PRODUCT UPDATE REQUEST ==========');
        console.log('Product ID:', id);
        console.log('Update Data:', JSON.stringify(updateData, null, 2));

        const result = await updateDocument('products', id, updateData);

        console.log('Update Result:', result);
        console.log('===========================================');

        if (result.success) {
            // Check for low stock after manual update
            if (updateData.available !== undefined) {
                const product = await getDocumentById('products', id);
                if (product.success) {
                    await checkAndNotifyLowStock(
                        product.data,
                        updateData.available,
                        product.data.unit,
                        'Manual Update'
                    );
                }
            }
            res.json({ success: true, message: 'Product updated successfully' });
        } else {
            res.status(500).json({ success: false, error: result.error });
        }
    } catch (error) {
        console.error('Error updating product:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete product
app.delete('/api/products/:id', async (req, res) => {
    try {
        const { id } = req.params;

        console.log('========== PRODUCT DELETE REQUEST ==========');
        console.log('Product ID:', id);

        const result = await deleteDocument('products', id);

        console.log('Delete Result:', result);
        console.log('===========================================');

        if (result.success) {
            res.json({ success: true, message: 'Product deleted successfully' });
        } else {
            res.status(500).json({ success: false, error: result.error });
        }
    } catch (error) {
        console.error('Error deleting product:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Reduce stock after order
app.post('/api/products/reduce-stock', async (req, res) => {
    try {
        const { items } = req.body; // Array of {id, quantity, size}

        const { getDocs, collection: firestoreCollection, query, where, updateDoc, doc: docFunc, getDoc } = await import('firebase/firestore');

        for (const item of items) {
            console.log(`Processing stock reduction for product ID: ${item.id}`);

            let targetProductDoc = null;

            // 1. Try Query by numeric ID field
            const numericId = parseInt(item.id);
            if (!isNaN(numericId)) {
                const productsQuery = query(
                    firestoreCollection(db, 'products'),
                    where('id', '==', numericId)
                );
                const querySnapshot = await getDocs(productsQuery);
                if (!querySnapshot.empty) {
                    targetProductDoc = querySnapshot.docs[0];
                }
            }

            // 2. Try Query by string ID field if not found or if numeric ID failed
            if (!targetProductDoc) {
                console.log(`Not found by numeric ID, trying string ID: ${item.id}`);
                const stringQuery = query(
                    firestoreCollection(db, 'products'),
                    where('id', '==', String(item.id))
                );
                const stringSnapshot = await getDocs(stringQuery);
                if (!stringSnapshot.empty) {
                    targetProductDoc = stringSnapshot.docs[0];
                }
            }

            // 3. Try direct document ID lookup if still not found
            if (!targetProductDoc && String(item.id).length > 5) {
                console.log(`Still not found, trying direct document ID lookup: ${item.id}`);
                try {
                    const directRef = docFunc(db, 'products', String(item.id));
                    const directSnap = await getDoc(directRef);
                    if (directSnap.exists()) {
                        targetProductDoc = directSnap;
                    }
                } catch (e) {
                    console.error('Error in direct doc lookup:', e);
                }
            }

            if (targetProductDoc) {
                const productData = targetProductDoc.data();
                const currentStock = Number(productData.available) || 0;

                // Get product unit - auto-detect if missing
                let productUnit = productData.unit;
                if (!productUnit) {
                    const category = (productData.category || '').toLowerCase();
                    productUnit = category.includes('oil') ? 'L' : 'kg';
                }

                // Calculate quantity to reduce
                let quantityToReduce = Number(item.quantity) || 0;

                // Handle size conversion
                if (item.size) {
                    const sizeMatch = String(item.size).match(/^([\d.]+)\s*(kg|gm|g|l|ml)$/i);
                    if (sizeMatch) {
                        const sizeValue = parseFloat(sizeMatch[1]);
                        const sizeUnit = sizeMatch[2].toLowerCase();
                        const productUnitLower = productUnit.toLowerCase();

                        if (productUnitLower === 'kg') {
                            if (sizeUnit === 'gm' || sizeUnit === 'g') quantityToReduce = item.quantity * (sizeValue / 1000);
                            else if (sizeUnit === 'kg') quantityToReduce = item.quantity * sizeValue;
                        } else if (productUnitLower === 'gm' || productUnitLower === 'g') {
                            if (sizeUnit === 'kg') quantityToReduce = item.quantity * (sizeValue * 1000);
                            else if (sizeUnit === 'gm' || sizeUnit === 'g') quantityToReduce = item.quantity * sizeValue;
                        } else if (productUnitLower === 'l') {
                            if (sizeUnit === 'ml') quantityToReduce = item.quantity * (sizeValue / 1000);
                            else if (sizeUnit === 'l') quantityToReduce = item.quantity * sizeValue;
                        } else if (productUnitLower === 'ml') {
                            if (sizeUnit === 'l') quantityToReduce = item.quantity * (sizeValue * 1000);
                            else if (sizeUnit === 'ml') quantityToReduce = item.quantity * sizeValue;
                        }
                    }
                }

                const newStock = Math.max(0, currentStock - quantityToReduce);
                const productRef = docFunc(db, 'products', targetProductDoc.id);

                await updateDoc(productRef, {
                    available: newStock,
                    inStock: newStock > 0,
                    updatedAt: new Date().toISOString()
                });

                console.log(`✅ Success: Reduced ${productData.name} from ${currentStock} to ${newStock} (${productUnit})`);

                // Use the helper to check and notify
                await checkAndNotifyLowStock(productData, newStock, productUnit, item.size);
            } else {
                console.warn(`❌ Failed: Product ID ${item.id} not found by any method`);
            }
        }

        res.json({ success: true, message: 'Stock updated successfully' });
    } catch (error) {
        console.error('Critical Error in reduce-stock:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Upload image to Firebase Storage
app.post('/api/upload/image', upload.single('image'), async (req, res) => {
    try {
        console.log('Image upload request received');

        if (!req.file) {
            console.error('No file in request');
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }

        console.log('File details:', {
            originalname: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size
        });

        // Validate file type
        const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
        if (!allowedTypes.includes(req.file.mimetype)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid file type. Only JPEG, PNG, GIF, and WebP images are allowed.'
            });
        }

        // Validate file size (max 5MB)
        const maxSize = 5 * 1024 * 1024; // 5MB
        if (req.file.size > maxSize) {
            return res.status(400).json({
                success: false,
                error: 'File too large. Maximum size is 5MB.'
            });
        }

        const timestamp = Date.now();
        const sanitizedFilename = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        const filename = `products/${timestamp}_${sanitizedFilename}`;

        console.log('Converting image to data URL (temporary solution)');

        // TEMPORARY SOLUTION: Convert image to base64 data URL
        // This works immediately without Firebase Storage
        // Images will be stored as part of the product document
        const base64Image = req.file.buffer.toString('base64');
        const dataUrl = `data:${req.file.mimetype};base64,${base64Image}`;

        const result = {
            success: true,
            url: dataUrl,
            path: filename
        };

        if (result.success) {
            console.log('Upload successful:', result.url);
            res.json({ success: true, url: result.url, path: result.path });
        } else {
            console.error('Upload failed:', result.error);
            res.status(500).json({
                success: false,
                error: result.error || 'Failed to upload image to storage'
            });
        }
    } catch (error) {
        console.error('Error uploading image:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Internal server error during image upload',
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// ============================================
// REVIEW ROUTES
// ============================================

// Add a review (with purchase verification)
app.post('/api/reviews', async (req, res) => {
    try {
        const { productId, userId, userName, rating, comment, image } = req.body;

        // Verify user has purchased this product
        const { getDocs, collection: firestoreCollection, query, where, addDoc, doc: docFunc, getDoc, updateDoc } = await import('firebase/firestore');

        const ordersQuery = query(
            firestoreCollection(db, 'orders'),
            where('userId', '==', userId)
        );

        const ordersSnapshot = await getDocs(ordersQuery);
        let hasPurchased = false;
        const productIdStr = String(productId);
        const productIdNum = parseInt(productId);

        console.log('Checking purchase history for productId:', productId, 'userId:', userId);

        ordersSnapshot.forEach((doc) => {
            const orderData = doc.data();
            console.log('Order items:', orderData.items?.map(i => ({ id: i.id, type: typeof i.id })));
            if (orderData.items && orderData.items.some(item => {
                const itemIdStr = String(item.id);
                const itemIdNum = parseInt(item.id);
                return itemIdStr === productIdStr || itemIdNum === productIdNum;
            })) {
                hasPurchased = true;
            }
        });

        if (!hasPurchased) {
            return res.status(403).json({
                success: false,
                error: 'You must purchase this product before reviewing it'
            });
        }

        // Check if user already reviewed this product
        const reviewsQuery = query(
            firestoreCollection(db, 'reviews'),
            where('productId', '==', productId),
            where('userId', '==', userId)
        );

        const reviewsSnapshot = await getDocs(reviewsQuery);

        if (!reviewsSnapshot.empty) {
            return res.status(400).json({
                success: false,
                error: 'You have already reviewed this product'
            });
        }


        // Add the review
        const reviewData = {
            productId,
            userId,
            userName,
            rating: Number(rating),
            comment,
            image: image || null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };


        const docRef = await addDoc(firestoreCollection(db, 'reviews'), reviewData);

        // Update product rating and review count - query by numeric id
        const productQuery = query(
            firestoreCollection(db, 'products'),
            where('id', '==', parseInt(productId))
        );
        const productSnapshot = await getDocs(productQuery);

        if (!productSnapshot.empty) {
            const productDoc = productSnapshot.docs[0];
            const productData = productDoc.data();
            const currentRating = productData.rating || 0;
            const currentReviews = productData.reviews || 0;

            const newReviewCount = currentReviews + 1;
            const newRating = ((currentRating * currentReviews) + Number(rating)) / newReviewCount;

            const productRef = docFunc(db, 'products', productDoc.id);
            await updateDoc(productRef, {
                rating: parseFloat(newRating.toFixed(1)),
                reviews: newReviewCount,
                updatedAt: new Date().toISOString()
            });
        }

        res.json({ success: true, id: docRef.id, message: 'Review added successfully' });
    } catch (error) {
        console.error('Error adding review:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get reviews for a product
app.get('/api/reviews/:productId', async (req, res) => {
    try {
        const { productId } = req.params;
        const { getDocs, collection: firestoreCollection, query, where } = await import('firebase/firestore');

        const reviewsQuery = query(
            firestoreCollection(db, 'reviews'),
            where('productId', '==', productId)
            // Note: orderBy('createdAt', 'desc') removed to avoid index requirement
            // To enable sorting, create the Firebase index using the link in the error message
        );

        const querySnapshot = await getDocs(reviewsQuery);
        const reviews = [];

        querySnapshot.forEach((doc) => {
            reviews.push({ id: doc.id, ...doc.data() });
        });

        // Sort in JavaScript instead (temporary solution)
        reviews.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        res.json({ success: true, data: reviews });
    } catch (error) {
        console.error('Error fetching reviews:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Check if user can review a product (must have delivered order)
app.get('/api/reviews/can-review/:productId/:userId', async (req, res) => {
    try {
        const { productId, userId } = req.params;
        const { getDocs, collection: firestoreCollection, query, where } = await import('firebase/firestore');

        // Check if user purchased the product AND it was delivered
        const ordersQuery = query(
            firestoreCollection(db, 'orders'),
            where('userId', '==', userId)
        );

        const ordersSnapshot = await getDocs(ordersQuery);
        let hasPurchasedAndDelivered = false;
        const productIdStr = String(productId);
        const productIdNum = parseInt(productId);

        console.log('========================================');
        console.log('REVIEW ELIGIBILITY CHECK');
        console.log('Product ID:', productId, '(type:', typeof productId + ')');
        console.log('User ID:', userId);
        console.log('Found orders:', ordersSnapshot.size);
        console.log('========================================');

        ordersSnapshot.forEach((doc) => {
            const orderData = doc.data();
            const orderStatus = (orderData.status || '').toLowerCase();

            console.log('\n--- Checking Order:', doc.id, '---');
            console.log('Order Status:', orderData.status, '→ normalized:', orderStatus);
            console.log('Status Match:', orderStatus === 'delivered');
            console.log('Has Items:', !!orderData.items);

            if (orderData.items) {
                console.log('Order Items:', orderData.items.length);
                orderData.items.forEach((item, index) => {
                    console.log(`  Item ${index + 1}:`, {
                        id: item.id,
                        type: typeof item.id,
                        name: item.name
                    });
                });
            }

            // Check if order contains the product AND status is "Delivered" (case-insensitive)
            if (orderStatus === 'delivered' && orderData.items && orderData.items.some(item => {
                const itemIdStr = String(item.id);
                const itemIdNum = parseInt(item.id);
                const match = itemIdStr === productIdStr || itemIdNum === productIdNum;

                if (match) {
                    console.log('✓✓✓ MATCH FOUND! ✓✓✓');
                    console.log('  Item ID:', item.id, '(', typeof item.id, ')');
                    console.log('  Product ID:', productId, '(', typeof productId, ')');
                }

                return match;
            })) {
                hasPurchasedAndDelivered = true;
                console.log('✓ User CAN review this product!');
            } else {
                console.log('✗ User CANNOT review (status or product mismatch)');
            }
        });

        console.log('\n========================================');
        console.log('FINAL RESULT: canReview =', hasPurchasedAndDelivered);
        console.log('========================================\n');

        if (!hasPurchasedAndDelivered) {
            return res.json({
                success: true,
                canReview: false,
                reason: 'not_delivered',
                message: 'You can only review products from delivered orders'
            });
        }

        // Check if user already reviewed
        const reviewsQuery = query(
            firestoreCollection(db, 'reviews'),
            where('productId', '==', productId),
            where('userId', '==', userId)
        );

        const reviewsSnapshot = await getDocs(reviewsQuery);

        if (!reviewsSnapshot.empty) {
            return res.json({ success: true, canReview: false, reason: 'already_reviewed' });
        }

        res.json({ success: true, canReview: true });
    } catch (error) {
        console.error('Error checking review eligibility:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Sync all product review counts with actual reviews in the database
app.post('/api/admin/sync-review-counts', async (req, res) => {
    try {
        const { getDocs, collection: firestoreCollection, query, updateDoc, doc: docFunc } = await import('firebase/firestore');

        const productsSnapshot = await getDocs(firestoreCollection(db, 'products'));
        const allReviewsSnapshot = await getDocs(firestoreCollection(db, 'reviews'));

        const reviewsByProduct = {};
        allReviewsSnapshot.forEach(doc => {
            const data = doc.data();
            const pid = String(data.productId);
            if (!reviewsByProduct[pid]) reviewsByProduct[pid] = [];
            reviewsByProduct[pid].push(data);
        });

        let updatedCount = 0;
        for (const productDoc of productsSnapshot.docs) {
            const productData = productDoc.data();
            const productId = String(productData.id);
            const productReviews = reviewsByProduct[productId] || [];

            const newReviewCount = productReviews.length;
            const newRating = newReviewCount > 0
                ? productReviews.reduce((sum, r) => sum + Number(r.rating), 0) / newReviewCount
                : 0;

            const productRef = docFunc(db, 'products', productDoc.id);
            await updateDoc(productRef, {
                reviews: newReviewCount,
                rating: parseFloat(newRating.toFixed(1)),
                updatedAt: new Date().toISOString()
            });
            updatedCount++;
        }

        res.json({
            success: true,
            message: `Synchronized review counts for ${updatedCount} products`,
            details: reviewsByProduct
        });
    } catch (error) {
        console.error('Error syncing review counts:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// RAZORPAY PAYMENT ROUTES
// ============================================

// Diagnostic route — check if Razorpay keys are loaded on the server
app.get('/api/payment/status', (req, res) => {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    res.json({
        success: true,
        razorpay_key_id_set: !!keyId,
        razorpay_key_id_prefix: keyId ? keyId.substring(0, 8) + '...' : null,
        razorpay_key_secret_set: !!keySecret,
    });
});

// Create Razorpay Order
app.post('/api/payment/create-order', async (req, res) => {
    try {
        const { amount, currency = 'INR', receipt } = req.body;

        if (!amount) {
            return res.status(400).json({ success: false, error: 'Amount is required' });
        }

        const options = {
            amount: Math.round(amount * 100), // Razorpay expects amount in paise (e.g., 50.00 INR = 5000 paise)
            currency,
            receipt: receipt || `receipt_${Date.now()}`,
        };

        console.log('--- Creating Razorpay Order ---');
        console.log('Options:', options);

        const razorpay = getRazorpay();
        const order = await razorpay.orders.create(options);

        console.log('Order Created:', order);
        res.json({
            success: true,
            orderId: order.id,
            amount: order.amount,
            currency: order.currency
        });
    } catch (error) {
        console.error('Razorpay Create Order Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Verify Razorpay Signature
app.post('/api/payment/verify-payment', async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

        if (!process.env.RAZORPAY_KEY_SECRET) {
            return res.status(500).json({ success: false, error: 'RAZORPAY_KEY_SECRET not configured on server' });
        }
        const sign = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSign = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(sign.toString())
            .digest("hex");

        if (razorpay_signature === expectedSign) {
            console.log('✅ Payment Verified Successfully');
            return res.json({ success: true, message: "Payment verified successfully" });
        } else {
            console.error('❌ Payment Verification Failed');
            return res.status(400).json({ success: false, error: "Invalid signature" });
        }
    } catch (error) {
        console.error('Razorpay Verification Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
    console.log(`🔥 Firebase connected successfully!`);
});
