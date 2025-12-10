/**
 * =============================================================
 * ONRAMP.MONEY AI KYC AGENT - PROFESSIONAL EDITION
 * =============================================================
 * * Architecture: Modular Monolith
 * - Service Layer: Handles Business Logic (AI, DB)
 * - Controller Layer: Handles HTTP Requests
 * - Utils: Helper functions
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- 1. CONFIGURATION & ENVIRONMENT ---
const CONFIG = {
    PORT: process.env.PORT || 3000,
    GEMINI_KEY: process.env.GEMINI_API_KEY,
    MONGO_URI: process.env.MONGO_URI,
    UPLOAD_DIR: 'uploads/',
    MODEL_NAME: 'gemini-1.5-flash', // Updated to stable version
};

// Fail fast if critical keys are missing
if (!CONFIG.GEMINI_KEY) {
    console.error("❌ CRITICAL: GEMINI_API_KEY is missing in .env");
    process.exit(1);
}

// --- 2. DATABASE MODELS ---
const connectDB = async () => {
    if (!CONFIG.MONGO_URI) return console.warn("⚠️  Running in InMemory Mode (No MongoDB URI)");
    try {
        await mongoose.connect(CONFIG.MONGO_URI);
        console.log("✅ Connected to MongoDB");
    } catch (err) {
        console.error("❌ MongoDB Connection Error:", err);
        process.exit(1);
    }
};

const SessionSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, unique: true, index: true },
    createdAt: { type: Date, default: Date.now },
    status: { type: String, enum: ['ACTIVE', 'APPROVED', 'REJECTED'], default: 'ACTIVE' },
    riskFlag: { type: Boolean, default: false },
    language: String,
    // Store chat history structured for Gemini
    history: [{ 
        role: { type: String, enum: ['user', 'model'] }, 
        parts: [{ text: String }] 
    }], 
    // Human readable transcript
    transcript: [{ sender: String, text: String, time: String }],
    videoPath: String,
    environmentLogs: [{ time: String, warning: String }]
});

const Session = mongoose.model('Session', SessionSchema);

// --- 3. AI SERVICE LAYER ---
class AIService {
    constructor() {
        this.genAI = new GoogleGenerativeAI(CONFIG.GEMINI_KEY);
        this.model = this.genAI.getGenerativeModel({ model: CONFIG.MODEL_NAME });
    }

    getSystemPrompt() {
        return `
            ROLE: Senior Financial Crime Investigator.
            GOAL: Detect fraud (Pig Butchering, Money Mules) efficiently.
            
            CONTEXT: You are verifying a user via video chat.
            
            RULES:
            1. Ask a maximum of 3 questions.
            2. Be professional but suspicious if answers are vague.
            3. Keep responses SHORT (One sentence).
            
            STRATEGY:
            - Q1: Purpose of transaction?
            - Q2: Who recommended this platform? (Probe for "online friends")
            - Q3: Were you promised guaranteed returns?
            
            DECISION LOGIC:
            - REJECT if: Mentions "Telegram task", "Job", "Mentor", "Guaranteed profit".
            - APPROVE if: Generic personal investment, credible answers.
            
            OUTPUT: JSON ONLY. No markdown blocks.
            Structure: { "next_question": "string", "kyc_status": "CONTINUE" | "APPROVED" | "REJECTED", "risk_flag": boolean }
        `;
    }

    getVisionPrompt() {
        return `
            Analyze this image for KYC Security. Return JSON ONLY.
            1. Face Check: Human face visible?
            2. Environment: Bathroom/Toilet (CRITICAL), Outdoor, Moving Vehicle.
            
            Output Structure:
            {
                "face_detected": boolean,
                "environment_warning": "NONE" | "BATHROOM" | "OUTDOOR" | "MOVING_VEHICLE",
                "message": "User warning string or null"
            }
        `;
    }

    async generateChatResponse(session, userText) {
        try {
            const chat = this.model.startChat({
                history: [
                    { role: "user", parts: [{ text: this.getSystemPrompt() }] },
                    ...session.history // Inject history from DB, not Client
                ],
                generationConfig: { responseMimeType: "application/json" }
            });

            const result = await chat.sendMessage(userText);
            const responseText = result.response.text();
            
            return JSON.parse(responseText);
        } catch (error) {
            console.error("AI Chat Error:", error);
            // Fallback safe response
            return { next_question: "I couldn't hear you, please repeat.", kyc_status: "CONTINUE", risk_flag: false };
        }
    }

    async analyzeImage(base64Image) {
        try {
            const cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, "");
            const result = await this.model.generateContent([
                this.getVisionPrompt(),
                { inlineData: { data: cleanBase64, mimeType: "image/jpeg" } }
            ]);
            const text = result.response.text();
            // Clean markdown if Gemini adds it despite instructions
            const jsonText = text.replace(/```json|```/g, '').trim(); 
            return JSON.parse(jsonText);
        } catch (error) {
            console.error("AI Vision Error:", error);
            return null;
        }
    }
}

const aiService = new AIService();

// --- 4. EXPRESS SETUP & MIDDLEWARE ---
const app = express();

// Security Headers
app.use(helmet({
    contentSecurityPolicy: false, // Disabled for inline scripts in this demo
}));

// Rate Limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use(limiter);

app.use(cors()); // Configure specific origins in production
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(CONFIG.UPLOAD_DIR));

// Ensure upload dir exists
if (!fs.existsSync(CONFIG.UPLOAD_DIR)) fs.mkdirSync(CONFIG.UPLOAD_DIR);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, CONFIG.UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `kyc-${Date.now()}-${Math.round(Math.random() * 1E9)}.webm`)
});
const upload = multer({ storage });

// --- 5. CONTROLLERS ---

// Start Session
app.post('/api/start', async (req, res) => {
    try {
        const { language } = req.body;
        const sessionId = Date.now().toString();
        const initialQ = language === 'hi-IN' ? "नमस्ते. वेरिफिकेशन के लिए अपना नाम बताएं?" : "Hello. Please state your name for verification?";

        // Initialize Session in DB
        if (CONFIG.MONGO_URI) {
            await Session.create({
                sessionId,
                language,
                history: [{ role: "model", parts: [{ text: JSON.stringify({ next_question: initialQ }) }] }],
                transcript: [{ sender: 'AI', text: initialQ, time: new Date().toISOString() }]
            });
        }

        res.json({ sessionId, next_question: initialQ });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Initialization failed" });
    }
});

// Process Answer
app.post('/api/process', async (req, res) => {
    const { sessionId, userText } = req.body;
    
    // 1. Fetch State
    let session;
    if (CONFIG.MONGO_URI) {
        session = await Session.findOne({ sessionId });
    } else {
        // Mock for in-memory
        session = { history: [] }; 
    }

    if (!session) return res.status(404).json({ error: "Session not found" });

    // 2. Call AI
    const decision = await aiService.generateChatResponse(session, userText);

    // 3. Update State (DB)
    if (CONFIG.MONGO_URI) {
        session.history.push({ role: "user", parts: [{ text: userText }] });
        session.history.push({ role: "model", parts: [{ text: JSON.stringify(decision) }] });
        
        session.transcript.push(
            { sender: 'USER', text: userText, time: new Date().toISOString() },
            { sender: 'AI', text: decision.next_question, time: new Date().toISOString() }
        );
        session.status = decision.kyc_status;
        session.riskFlag = decision.risk_flag;
        await session.save();
    }

    res.json(decision);
});

// Vision Check
app.post('/api/vision-check', async (req, res) => {
    const { image, sessionId } = req.body;
    if (!image) return res.status(400).json({ error: "No image" });

    const analysis = await aiService.analyzeImage(image);

    if (analysis?.message && CONFIG.MONGO_URI) {
        await Session.findOneAndUpdate({ sessionId }, {
            $push: { environmentLogs: { time: new Date().toISOString(), warning: analysis.message } }
        });
    }

    res.json(analysis || {});
});

// Video Upload
app.post('/api/upload-video', upload.single('video'), async (req, res) => {
    const { sessionId } = req.body;
    if (req.file && CONFIG.MONGO_URI) {
        await Session.findOneAndUpdate({ sessionId }, { videoPath: req.file.path });
    }
    res.json({ success: !!req.file });
});

// Admin Dashboard Data
app.get('/api/admin/sessions', async (req, res) => {
    if (!CONFIG.MONGO_URI) return res.json([]);
    const sessions = await Session.find().sort({ createdAt: -1 }).limit(50);
    res.json(sessions);
});

// --- 6. FRONTEND SERVING ---
// In a real pro environment, this returns a built React bundle. 
// For this standalone usage, we serve the HTML template.
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- 7. STARTUP ---
connectDB().then(() => {
    app.listen(CONFIG.PORT, () => {
        console.log(`🚀 Server running on http://localhost:${CONFIG.PORT}`);
    });
});
