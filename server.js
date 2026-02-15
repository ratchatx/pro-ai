// server.js
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
// import pdfParse from 'pdf-parse'; // CommonJS module issue
import Tesseract from 'tesseract.js';
import OpenAI from 'openai';
import { ChromaClient } from "chromadb";
import { DefaultEmbeddingFunction } from "@chroma-core/default-embed";
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { Client, middleware } from '@line/bot-sdk';
import dotenv from 'dotenv';
import * as DurianMCP from './services/durian_mcp.js';
dotenv.config();

const require = createRequire(import.meta.url);
const pdfParseModule = require('pdf-parse');
const pdfParse = pdfParseModule.default || pdfParseModule;
const mammoth = require('mammoth');

// Fix for __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Request Logger Middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Fix Favicon 404
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Update your API Key here
const TYPHOON_API_KEY = process.env.TYPHOON_API_KEY || "sk-Ugp2OuKpCEfuna8201OisRpqZl477xT3CL10g8Jl1sHzvnYX";

// --- LINE CONFIGURATION ---
const LINE_CONFIG = {
    channelId: process.env.LINE_CHANNEL_ID,
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET
};

if (!LINE_CONFIG.channelAccessToken || !LINE_CONFIG.channelSecret) {
    console.error("❌ ERROR: LINE_CHANNEL_ACCESS_TOKEN or LINE_CHANNEL_SECRET is missing in .env");
}

const lineClient = new Client(LINE_CONFIG);

// --- CHAT DB (For Line History & Manual Mode) ---
const CHATS_FILE = 'chats.json';
let chatsDB = { conversations: {} }; // userId: { mode: 'ai'|'manual', messages: [] }

if (fs.existsSync(CHATS_FILE)) {
    try {
        chatsDB = JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8'));
    } catch (e) { console.error("Error reading chats DB"); }
}
function saveChatsDB() { fs.writeFileSync(CHATS_FILE, JSON.stringify(chatsDB, null, 2)); }

// Helper to add message to chat history
function addMessageToChat(userId, role, content) {
    if (!chatsDB.conversations[userId]) {
        chatsDB.conversations[userId] = { mode: 'ai', messages: [] };
    }
    // Limit history length strictly to avoid huge files? For now, keep it simple.
    chatsDB.conversations[userId].messages.push({
        role, 
        content, 
        timestamp: new Date().toISOString()
    });
    // Keep last 50 messages
    if (chatsDB.conversations[userId].messages.length > 50) {
        chatsDB.conversations[userId].messages.shift();
    }
    saveChatsDB();
}

// --- 1. SETUP & CONFIGURATION ---

// Typhoon Setup
const typhoon = new OpenAI({
    apiKey: TYPHOON_API_KEY,
    baseURL: "https://api.opentyphoon.ai/v1",
});

// Chroma Setup
const chromaClient = new ChromaClient({ path: "http://localhost:8000" });
const embedder = new DefaultEmbeddingFunction();
const COLLECTION_NAME = "my_assignment_docs";

// Storage for file metadata (Simple text DB)
const DB_FILE = 'db.json';
let db = { files: [] };

// Load DB
if (fs.existsSync(DB_FILE)) {
    try {
        db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        console.error("Error reading DB, starting fresh.");
    }
}

function saveDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Multer Setup for Uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir);
        }
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        try {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            
            // Try to fix encoding, but fallback safely
            let safeName = file.originalname;
            try {
                // Only attempt conversion if it looks like garbled latin1
                const converted = Buffer.from(file.originalname, 'latin1').toString('utf8');
                // Basic check: if conversion results in weird characters, unlikely correct?
                // Actually, for Thai, it is correct. We'll trust the conversion but sanitize heavily.
                safeName = converted;
            } catch (e) {
                console.warn("Filename encoding conversion failed:", e);
            }

            // Sanitize filename for Windows: remove invalid chars
            // Invalid: < > : " / \ | ? *
            safeName = safeName.replace(/[<>:"/\\|?*]/g, '_');
            
            // Trim and ensure not empty
            safeName = safeName.trim();
            if (!safeName || safeName === '.' || safeName === '..') {
                safeName = 'unnamed_file';
            }

            cb(null, uniqueSuffix + '-' + safeName);
        } catch (error) {
            console.error("Error generating filename:", error);
            // Fallback to simple name
            cb(null, Date.now() + '-file.bin');
        }
    }
});
const upload = multer({ storage: storage });

app.use(cors());

// --- LINE WEBHOOK ---
// Must be before express.json() because it needs raw body for signature validation
// We define the handler separately to keep code clean
app.post('/webhook', middleware(LINE_CONFIG), (req, res) => {
    Promise.all(req.body.events.map(handleLineEvent))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error(err);
            res.status(500).end();
        });
});

app.use(express.json());
app.use(express.static('public')); // Serve frontend from public folder

// --- 2. API ENDPOINTS: FILE MANAGEMENT ---

// List all files
app.get('/api/files', (req, res) => {
    res.json(db.files);
});

// Upload files
app.post('/api/upload', (req, res, next) => {
    upload.array('files')(req, res, (err) => {
        if (err) {
            console.error("Multer Upload Error:", err);
            return res.status(500).json({ error: "File upload failed", details: err.message });
        }
        next();
    });
}, (req, res) => {
    try {
        const uploadedFiles = req.files;
        if (!uploadedFiles || uploadedFiles.length === 0) {
            return res.status(400).json({ error: "No files provided" });
        }
        
        const newFiles = uploadedFiles.map(file => {
            // Try decoding, fallback to raw if fails
            let finalOrigName = file.originalname;
            try {
                finalOrigName = Buffer.from(file.originalname, 'latin1').toString('utf8');
            } catch (e) { /* ignore */ }
            
            return {
                id: uuidv4(),
                originalName: finalOrigName,
                filename: file.filename,
                path: file.path,
                mimeType: file.mimetype,
                status: 'raw', // raw -> converted -> vectorized
                markdownContent: '', // store extracted text here
                uploadDate: new Date().toISOString()
            };
        });

        db.files.push(...newFiles);
        saveDB();

        res.json({ message: 'Files uploaded successfully', files: newFiles });
    } catch (error) {
        console.error("Upload Handler Error:", error);
        res.status(500).json({ error: "Internal Server Error during file processing", details: error.message });
    }
});

// Delete File
app.delete('/api/files/:id', async (req, res) => {
    const fileId = req.params.id;
    const fileIndex = db.files.findIndex(f => f.id === fileId);

    if (fileIndex === -1) return res.status(404).json({ error: 'File not found' });

    const fileRecord = db.files[fileIndex];

    try {
        // 1. Delete physical file
        const filePath = path.join(__dirname, fileRecord.path);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        // 2. Delete vectors from Chroma (if vectorized)
         // Note: We try to delete even if not marked as vectorized to be safe, 
         // but Chroma might throw if collection doesn't exist.
        try {
            const collection = await chromaClient.getCollection({ name: COLLECTION_NAME, embeddingFunction: embedder });
            if (collection) {
                 await collection.delete({ where: { fileId: fileId } });
            }
        } catch (e) {
            // Ignore if collection not found or connection failed, just proceed to delete record
            console.log("Vector delete skipped or failed:", e.message);
        }

        // 3. Remove from DB
        db.files.splice(fileIndex, 1);
        saveDB();

        res.json({ message: 'File deleted successfully' });

    } catch (error) {
        console.error("Delete Error:", error);
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

// Convert PDF/Image to Markdown
app.post('/api/convert/:id', async (req, res) => {
    const fileId = req.params.id;
    const fileRecord = db.files.find(f => f.id === fileId);

    if (!fileRecord) return res.status(404).json({ error: 'File not found' });
    if (fileRecord.status !== 'raw' && fileRecord.status !== 'converted') {
        // Allow re-conversion
    }

    try {
        let text = "";
        const filePath = path.join(__dirname, fileRecord.path);
        
        console.log(`Converting file: ${fileRecord.originalName} (${fileRecord.mimeType})`);
        console.log(`File path: ${filePath}`);
        
        // Check if file exists
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found at path: ${filePath}`);
        }

        if (fileRecord.mimeType === 'application/pdf') {
            console.log('Processing PDF...');
            const dataBuffer = fs.readFileSync(filePath);
            const data = await pdfParse(dataBuffer);
            text = data.text;
        } else if (fileRecord.mimeType.startsWith('image/')) {
            console.log('Processing Image with OCR...');
            const result = await Tesseract.recognize(filePath, 'eng+tha'); 
            text = result.data.text;
        } else if (fileRecord.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            console.log('Processing DOCX...');
            const result = await mammoth.extractRawText({ path: filePath });
            text = result.value;
        } else {
            // Default fallback if text file
            console.log('Processing as text file...');
            try {
                if (fileRecord.originalName.endsWith('.docx')) {
                    // Fallback if mimetype was wrong but ext is docx
                    const result = await mammoth.extractRawText({ path: filePath });
                    text = result.value;
                } else if (fileRecord.originalName.endsWith('.txt')) {
                    text = fs.readFileSync(filePath, 'utf8');
                } else {
                    // Try to read as text
                    text = fs.readFileSync(filePath, 'utf8');
                }
            } catch (err) {
                console.error('Fallback conversion error:', err);
                return res.status(400).json({ 
                    error: 'Unsupported file type for conversion',
                    details: `File type ${fileRecord.mimeType} is not supported. Supported: PDF, Images, DOCX, TXT`
                });
            }
        }

        // Clean up some common garbage characters if needed
        text = text.replace(/\0/g, '');
        
        // Validate we got some text
        if (!text || text.trim().length === 0) {
            console.warn('Warning: Conversion resulted in empty text');
            text = '(No text content extracted from this file)';
        }
        
        console.log(`Conversion successful. Extracted ${text.length} characters.`);

        fileRecord.markdownContent = text;
        fileRecord.status = 'converted';
        saveDB();

        res.json({ message: 'Conversion successful', file: fileRecord });

    } catch (error) {
        console.error("Conversion Error Details:");
        console.error("- Message:", error.message);
        console.error("- Stack:", error.stack);
        console.error("- File:", fileRecord.originalName);
        console.error("- Type:", fileRecord.mimeType);
        
        // Send full error details to client
        res.status(500).json({ 
            error: 'Conversion failed', 
            details: error.message || 'Unknown error occurred',
            fileType: fileRecord.mimeType,
            fileName: fileRecord.originalName
        });
    }
});

// Get Markdown Content for Editing
app.get('/api/files/:id/content', (req, res) => {
    const fileRecord = db.files.find(f => f.id === req.params.id);
    if (!fileRecord) return res.status(404).json({ error: 'File not found' });
    res.json({ content: fileRecord.markdownContent });
});

// Save Edited Markdown Content
app.put('/api/files/:id/content', (req, res) => {
    const fileRecord = db.files.find(f => f.id === req.params.id);
    if (!fileRecord) return res.status(404).json({ error: 'File not found' });
    
    fileRecord.markdownContent = req.body.content;
    fileRecord.status = 'converted'; 
    saveDB();
    res.json({ message: 'Content updated' });
});

// --- 3. API ENDPOINTS: VECTOR DB MANAGEMENT ---

// Embed (Vectorize) a file
app.post('/api/embed/:id', async (req, res) => {
    const fileId = req.params.id;
    const fileRecord = db.files.find(f => f.id === fileId);

    if (!fileRecord) return res.status(404).json({ error: 'File not found' });
    if (!fileRecord.markdownContent) return res.status(400).json({ error: 'No content to embed. Convert first.' });

    try {
        // Check Chroma Connection
        try {
            await chromaClient.heartbeat();
        } catch (e) {
            throw new Error("ChromaDB connection failed. Please run 'chroma run --path ./chroma'");
        }

        const collection = await chromaClient.getOrCreateCollection({
            name: COLLECTION_NAME,
            embeddingFunction: embedder,
        });

        // Simple chunking strategy
        const chunks = fileRecord.markdownContent.split(/\n\s*\n/).filter(t => t.trim().length > 0);
        
        // If file is empty or just whitespace
        if (chunks.length === 0 && fileRecord.markdownContent.trim().length > 0) {
            chunks.push(fileRecord.markdownContent);
        }

        if (chunks.length > 0) {
            // Generate unique IDs for each chunk
            const ids = chunks.map((_, i) => `${fileId}_chunk_${i}`);
            
            // Sanitize metadata for Chroma (ASCII only to be safe, or just minimal)
            // Use EncodeURI to ensure safe characters in metadata if Thai causes issues
            const safeSource = encodeURIComponent(fileRecord.originalName);
             
            const metadatas = chunks.map((_, i) => ({ 
                source: safeSource, 
                fileId: fileId, 
                chunkIndex: i 
            }));
            
            console.log(`Adding ${chunks.length} chunks to Chroma for file ${fileId}`);
            
            // Cleanup old chunks first
            try {
                await collection.delete({ where: { fileId: fileId } }); 
            } catch (e) { /* ignore */ }
    
            await collection.add({
                ids: ids,
                documents: chunks,
                metadatas: metadatas
            });
        }

        fileRecord.status = 'vectorized';
        saveDB();

        res.json({ message: 'Embed processing complete', chunksProcessed: chunks.length });

    } catch (error) {
        console.error("Embedding Error Stack:", error.stack);
        console.error("Embedding Error Msg:", error.message);
        
        // Check if it's a connection error (fetch failed) and warn user
        const isConnectionError = error.message.includes('fetch failed') || error.code === 'ECONNREFUSED';
        const userMsg = isConnectionError 
            ? "Cannot connect to ChromaDB. Please make sure running 'chroma run' in another terminal." 
            : "Embedding failed: " + error.message;

        res.status(500).json({ 
            error: userMsg, 
            details: error.message,
            stack: error.stack
        });
    }
});

// List Collections
app.get('/api/collections', async (req, res) => {
    try {
        const collections = await chromaClient.listCollections();
        res.json(collections);
    } catch (error) {
        res.json([]); // Fail safely or assume no collections or connection error
    }
});

// Delete Collection
app.delete('/api/collections/:name', async (req, res) => {
    try {
        await chromaClient.deleteCollection({ name: req.params.name });
        res.json({ message: `Collection ${req.params.name} deleted` });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete collection' });
    }
});

// --- 4. API ENDPOINTS: CHATBOT ---

app.post('/api/chat', async (req, res) => {
    const { message, history } = req.body; 

    try {
        const responseCallback = await getAIResponse(message, history);
        
        res.json({ 
            role: "assistant", 
            content: responseCallback.text,
            contextUsed: responseCallback.contextUsed,
            flex: responseCallback.flex 
        });

    } catch (error) {
        console.error("Chat Error Detailed:", error);
        
        if (error.status === 401) {
             return res.status(401).json({ 
                 error: "API Key Invalid (401)", 
                 details: "Check TYPHOON_API_KEY." 
             });
        }

        res.status(500).json({ 
            error: "Failed to generate response.", 
            details: error.message 
        });
    }
});



// --- HELPER: TOOL PARSING (NO MODEL TOOLS) ---
function parseThaiDate(text) {
    const today = new Date();
    const isoMatch = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (isoMatch) {
        const [_, y, m, d] = isoMatch;
        return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }

    const slashMatch = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (slashMatch) {
        const [_, d, m, y] = slashMatch;
        return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }

    if (/วันนี้/.test(text)) {
        return today.toISOString().slice(0, 10);
    }

    return null;
}

function parseCountWeight(text) {
    const countMatch = text.match(/(\d+(?:\.\d+)?)\s*(ลูก)/);
    const weightMatch = text.match(/(\d+(?:\.\d+)?)\s*(กก\.?|กิโล(?:กรัม)?)/);

    const count = countMatch ? Number(countMatch[1]) : null;
    const weight = weightMatch ? Number(weightMatch[1]) : null;
    return { count, weight };
}

function parseYear(text) {
    const yearMatch = text.match(/(20\d{2})/);
    return yearMatch ? Number(yearMatch[1]) : null;
}

async function tryHandleDurianTool(text) {
    try {
        const lower = text.toLowerCase();

        const wantsStats = /สรุป|กราฟ|รายงาน|ยอด/.test(lower);
        const wantsRecord = /บันทึก|เก็บ|ได้|เก็บเกี่ยว/.test(lower) && /ลูก|กก\.?|กิโล/.test(lower);

        if (wantsStats) {
            const year = parseYear(text);
            const result = await DurianMCP.handlers.get_harvest_stats({ year: year || undefined });
            return { handled: true, text: result.message, flex: result.flexMessage || null };
        }

        if (wantsRecord) {
            const { count, weight } = parseCountWeight(text);
            const date = parseThaiDate(text) || new Date().toISOString().slice(0, 10);

            if (count == null || weight == null) {
                return { handled: true, text: "กรุณาระบุจำนวนลูกและน้ำหนัก เช่น 120 ลูก 350 กิโล วันที่ 2026-02-03", flex: null };
            }

            const result = await DurianMCP.handlers.record_harvest({ count, weight, date });
            return { handled: true, text: result.message, flex: null };
        }

        return { handled: false };
    } catch (error) {
        console.error("Durian tool error:", error);
        return { handled: true, text: "ขออภัย ระบบเครื่องมือเกิดข้อผิดพลาดชั่วคราว", flex: null };
    }
}

async function createTyphoonChatCompletion(messages) {
    const envModel = process.env.TYPHOON_MODEL;
    const modelCandidates = [
        envModel,
        'typhoon-v2.5-30b-a3b-instruct',
        'typhoon-v2.1-12b-instruct',
        'typhoon-v1.5x-70b-instruct',
        'typhoon-v1.5-70b-instruct'
    ].filter(Boolean);

    let lastError = null;
    for (const model of modelCandidates) {
        try {
            return await typhoon.chat.completions.create({
                model,
                messages,
                temperature: 0.6,
                max_tokens: 512,
                top_p: 0.9
            });
        } catch (error) {
            lastError = error;
            const status = error?.status || 'unknown';
            console.warn(`Typhoon model failed: ${model} (status ${status})`);
            if (status !== 400 && status !== 404) throw error;

            // Retry with minimal parameters (some gateways reject extra params)
            try {
                return await typhoon.chat.completions.create({
                    model,
                    messages
                });
            } catch (secondError) {
                lastError = secondError;
                const secondStatus = secondError?.status || 'unknown';
                console.warn(`Typhoon minimal request failed: ${model} (status ${secondStatus})`);
                if (secondStatus !== 400 && secondStatus !== 404) throw secondError;
            }
        }
    }

    throw lastError || new Error('Typhoon chat completion failed');
}

// --- HELPER: AI GENERATION LOGIC ---
async function getAIResponse(message, history) {
    let contextText = "";
    let contextDocs = [];

    try {
        const collection = await chromaClient.getOrCreateCollection({ name: COLLECTION_NAME, embeddingFunction: embedder });
        const results = await collection.query({ queryTexts: [message], nResults: 3 });
        contextDocs = results.documents[0] || [];
        contextText = contextDocs.join("\n---\n");
    } catch (e) { 
        console.warn("RAG Error (continuing without context):", e.message); 
    }

    const systemPrompt = `You are a helpful assistant. Use the provided context to answer the question in Thai or English as requested. If the context doesn't contain the answer, say "I don't find this information in the documents" but you can try to answer from general knowledge if appropriate, but warn the user.`;
    
    let messages = [{ role: "system", content: systemPrompt }];
    
    if (history && Array.isArray(history)) {
       const mappedHistory = history.map(h => ({
           role: (h.role === 'admin' || h.role === 'assistant') ? 'assistant' : 'user',
           content: h.content
       })).filter(h => h.content && typeof h.content === 'string');
       messages = messages.concat(mappedHistory.slice(-6));
    }
    
    messages.push({ 
        role: "user", 
        content: `Context:\n${contextText}\n\nQuestion: ${message}` 
    });

    // Try deterministic MCP tool handling first (no model tools)
    const toolResult = await tryHandleDurianTool(message);
    if (toolResult.handled) {
        return { text: toolResult.text, flex: toolResult.flex, contextUsed: contextDocs };
    }

    // Plain LLM response (no tools)
    try {
        const completion = await createTyphoonChatCompletion(messages);
        return { text: completion.choices[0].message.content, flex: null, contextUsed: contextDocs };
    } catch (error) {
        console.error("Typhoon chat failed after retries:", error?.status || error?.message || error);
        return { 
            text: "ตอนนี้ระบบ AI ไม่พร้อมใช้งานชั่วคราว แต่คุณยังสามารถขอให้บันทึกข้อมูลหรือสรุปกราฟได้ครับ", 
            flex: null, 
            contextUsed: contextDocs 
        };
    }
}

// --- LINE EVENT HANDLER ---
async function handleLineEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') {
        return Promise.resolve(null);
    }
    
    const userId = event.source.userId;
    const userText = event.message.text;
    
    // 1. Save User Message
    addMessageToChat(userId, 'user', userText);

    // 2. Check Conversation Mode
    const conversation = chatsDB.conversations[userId];
    const mode = conversation ? conversation.mode : 'ai';
    
    // If in MANUAL mode, stop here. Admin must reply from dashboard.
    if (mode === 'manual') {
        return Promise.resolve(null);
    }

    // 3. AI Mode: Generate Reply
    // Get history (excluding current message we just added? actually RAG usually wants strictly past history, but here we construct prompt fresh)
    const history = conversation ? conversation.messages.slice(0, -1) : []; 

    try {
        const response = await getAIResponse(userText, history);
        
        // Save Assistant Message
        addMessageToChat(userId, 'assistant', response.text);
        
        // Construct Line messages array
        const messagesToSend = [{ type: 'text', text: response.text }];
        
        // Append Flex Message if exists
        if (response.flex) {
            messagesToSend.push(response.flex);
        }

        return lineClient.replyMessage(event.replyToken, messagesToSend);
    } catch (err) {
        console.error("AI Error:", err);
        return lineClient.replyMessage(event.replyToken, {
            type: 'text',
            text: "ขออภัย ระบบ AI มีปัญหาชั่วคราว"
        });
    }
}

// --- ADMIN API ENDPOINTS ---

// Get all chats summary
app.get('/api/admin/chats', (req, res) => {
    const summary = Object.keys(chatsDB.conversations).map(userId => {
        const conv = chatsDB.conversations[userId];
        const lastMsg = conv.messages[conv.messages.length - 1];
        return {
            userId,
            mode: conv.mode,
            lastMessage: lastMsg ? lastMsg.content : "",
            lastActive: lastMsg ? lastMsg.timestamp : null
        };
    });
    // Sort by last active desc
    summary.sort((a, b) => new Date(b.lastActive) - new Date(a.lastActive));
    res.json(summary);
});

// Get chat history for specific user
app.get('/api/admin/chats/:userId', (req, res) => {
    const userId = req.params.userId;
    if (chatsDB.conversations[userId]) {
        res.json(chatsDB.conversations[userId]);
    } else {
        res.status(404).json({ error: "User not found" });
    }
});

// Toggle Mode
app.post('/api/admin/chats/:userId/mode', (req, res) => {
    const userId = req.params.userId;
    const { mode } = req.body; // 'ai' or 'manual'
    
    if (!chatsDB.conversations[userId]) {
         chatsDB.conversations[userId] = { mode: 'ai', messages: [] };
    }
    
    // Validate mode
    if (mode !== 'ai' && mode !== 'manual') return res.status(400).json({ error: 'Invalid mode' });

    chatsDB.conversations[userId].mode = mode;
    saveChatsDB();
    res.json({ success: true, mode: chatsDB.conversations[userId].mode });
});

// Admin Reply
app.post('/api/admin/chats/:userId/reply', async (req, res) => {
    const userId = req.params.userId;
    const { text } = req.body;
    
    if (!text) return res.status(400).json({ error: "No text provided" });

    // Save Admin Message
    addMessageToChat(userId, 'admin', text); 

    try {
        await lineClient.pushMessage(userId, {
            type: 'text',
            text: text
        });
        res.json({ success: true });
    } catch (err) {
        console.error("Line Push Error:", err);
        res.status(500).json({ error: "Failed to send message via Line", details: err.originalError?.response?.data || err.message });
    }
});


app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
