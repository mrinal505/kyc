/**
 * ============================================================================
 *  PROJECT: Onramp.money AI Verification Agent (Auto-Healing Version)
 *  AUTHOR: Senior Backend Engineering Team
 *  DESCRIPTION: 
 *    Conducts live KYC interviews. Includes a "Model Negotiator" that 
 *    automatically finds a valid Google Gemini model to prevent 404/403 errors.
 * ============================================================================
 */

require('dotenv').config(); 
const express = require('express');
const cors = require('cors');

// --- APP STATE ---
const APP_STATE = {
    PORT: process.env.PORT || 3000,
    API_KEY: process.env.GEMINI_API_KEY ,
    // This will be updated automatically by the Model Negotiator
    ACTIVE_MODEL: "gemini-pro" // Safe fallback
};

const app = express();
app.use(cors());
app.use(express.json());
const sessionStore = new Map();

// --- AI BRAIN (PERSONA) ---
const SYSTEM_PERSONA = `
IDENTITY: 
You are "Sarah," a senior Compliance Officer at Onramp.money. 
You are NOT a robot. You are a professional human verifying a user.

TONE & STYLE:
- Speak naturally and conversationally.
- Use "Fillers" and "Bridges" to sound human (e.g., "Okay, I see...", "That makes sense.", "Just a moment...").
- Do NOT output markdown or bullet points. Speak in clear, short sentences suitable for Text-to-Speech.

INTERVIEW FLOW:
1. START: Ask why they are buying crypto.
   - If "Investment" -> Ask "What specifically made you choose this token?"
   - If "Job/Task" -> RED FLAG.
   
2. SOURCE CHECK:
   - If "Friend/Teacher" -> Ask "Have you met them in real life?"
   - If "Telegram/WhatsApp" -> Ask "Did they promise you guaranteed profits?"

DECISION RULES:
- REJECT IF: User mentions "Task/Job", "Online BF/GF", "Telegram Mentor", "Guaranteed Returns".
- APPROVE IF: User shows clear, independent understanding of risks.

OUTPUT FORMAT (JSON ONLY):
{
  "spoken_response": "String (The natural text you will speak)",
  "language_code": "String (Keep user's language: 'en-IN' or 'hi-IN')",
  "risk_detected": Boolean,
  "status": "CONTINUE" | "APPROVED" | "REJECTED"
}
`;

// --- SERVICE: MODEL NEGOTIATOR ---
// This prevents 404/403 errors by finding what models actually exist for your key.
async function negotiateBestModel() {
    console.log("🔍 Negotiating with Google API for available models...");
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${APP_STATE.API_KEY}`);
        const data = await response.json();
        
        if (data.error) throw new Error(data.error.message);

        // Filter models that support 'generateContent'
        const validModels = data.models.filter(m => m.supportedGenerationMethods.includes("generateContent"));
        
        if (validModels.length === 0) throw new Error("No compatible models found for this API Key.");

        // Priority List: Try to find the fastest/cheapest first
        const priorities = ['gemini-1.5-flash', 'gemini-1.5-flash-001', 'gemini-1.5-pro', 'gemini-pro'];
        
        let selectedModel = null;

        // 1. Try to match strictly
        for (const p of priorities) {
            const match = validModels.find(m => m.name.endsWith(p));
            if (match) {
                selectedModel = match.name.split('/').pop(); // Remove 'models/' prefix
                break;
            }
        }

        // 2. Fallback to whatever is available
        if (!selectedModel) {
            selectedModel = validModels[0].name.split('/').pop();
        }

        APP_STATE.ACTIVE_MODEL = selectedModel;
        console.log(`✅ Model Locked: ${APP_STATE.ACTIVE_MODEL}`);
        return APP_STATE.ACTIVE_MODEL;

    } catch (e) {
        console.error("⚠️ Negotiation Failed. Defaulting to 'gemini-pro'. Error:", e.message);
        APP_STATE.ACTIVE_MODEL = "gemini-pro";
        return "gemini-pro";
    }
}

// --- SERVICE: GEMINI API ---
const GeminiService = {
    async generateResponse(history, userInput) {
        if (!APP_STATE.API_KEY) throw new Error("GEMINI_API_KEY is missing.");

        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${APP_STATE.ACTIVE_MODEL}:generateContent?key=${APP_STATE.API_KEY}`;

        const contents = history.map(entry => ({
            role: entry.role === 'ai' ? 'model' : 'user',
            parts: [{ text: entry.text }]
        }));

        // Strict JSON instruction
        contents.push({ role: "user", parts: [{ text: userInput + " (Reply in JSON only)" }] });

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents })
            });

            if (!response.ok) {
                const errText = await response.text();
                if (response.status === 404) {
                    // Re-negotiate if model suddenly disappears
                    await negotiateBestModel();
                    throw new Error("MODEL_NOT_FOUND_RETRYING");
                }
                if (response.status === 429) throw new Error("RATE_LIMIT");
                throw new Error(`Google API Error (${response.status}): ${errText}`);
            }

            const data = await response.json();
            let rawText = data.candidates[0].content.parts[0].text;
            rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
            
            return JSON.parse(rawText);

        } catch (error) {
            console.error("[Gemini Service]", error.message);
            throw error;
        }
    }
};

// --- ROUTES ---

// 1. Start Session
app.post('/api/start', async (req, res) => {
    try {
        // Ensure we have a valid model before starting
        if (APP_STATE.ACTIVE_MODEL === "gemini-pro" || !APP_STATE.ACTIVE_MODEL) {
            await negotiateBestModel();
        }

        const { language = 'en-IN' } = req.body;
        const sessionId = Date.now().toString();

        const greetingMap = {
            'en-IN': "Hello, I'm Sarah from Onramp. Can you tell me, in your own words, why you're buying crypto today?",
            'hi-IN': "नमस्ते, मैं सारा हूँ। क्या आप बता सकते हैं कि आज आप क्रिप्टो क्यों खरीद रहे हैं?"
        };

        const initialGreeting = greetingMap[language] || greetingMap['en-IN'];

        const sessionData = {
            id: sessionId,
            language,
            history: []
        };

        sessionData.history.push({ 
            role: "user", 
            text: SYSTEM_PERSONA + `\nCONTEXT: User speaks '${language}'. Reply in this language.` 
        });

        sessionData.history.push({ 
            role: "ai", 
            text: JSON.stringify({ spoken_response: initialGreeting }) 
        });

        sessionStore.set(sessionId, sessionData);

        res.json({ 
            sessionId, 
            spoken_response: initialGreeting, 
            language_code: language,
            status: "CONTINUE"
        });

    } catch (error) {
        res.status(500).json({ error: "Failed to start session" });
    }
});

// 2. Process Answer
app.post('/api/process', async (req, res) => {
    const { sessionId, userText } = req.body;
    const session = sessionStore.get(sessionId);

    if (!session) return res.status(404).json({ error: "Session not found" });

    try {
        const aiDecision = await GeminiService.generateResponse(session.history, userText);

        session.history.push({ role: "user", text: userText });
        session.history.push({ role: "ai", text: JSON.stringify(aiDecision) });

        console.log(`[Interaction] User: "${userText}" -> AI: "${aiDecision.spoken_response}"`);
        res.json(aiDecision);

    } catch (error) {
        let fallback = "I didn't quite catch that. Could you repeat?";
        if (error.message === "RATE_LIMIT") fallback = "One moment please, I am processing...";
        
        res.json({ 
            spoken_response: fallback, 
            language_code: session.language, 
            status: "CONTINUE" 
        });
    }
});

// 3. Serve Frontend
app.get('/', (req, res) => {
    res.send(FRONTEND_HTML_TEMPLATE);
});

// Start Server
app.listen(APP_STATE.PORT, async () => {
    console.log(`\n🚀 Server is live on port ${APP_STATE.PORT}`);
    // Trigger negotiation on startup
    await negotiateBestModel();
});

// --- FRONTEND TEMPLATE ---
const FRONTEND_HTML_TEMPLATE = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Onramp Verification</title>
    <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/babel-standalone@6/babel.min.js"></script>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Inter', sans-serif; background-color: #F8FAFC; color: #1E293B; }
        .video-mirror { transform: scaleX(-1); }
    </style>
</head>
<body class="h-screen overflow-hidden flex flex-col">
    <div id="root" class="h-full w-full"></div>
    <script type="text/babel">
        const { useState, useEffect, useRef } = React;

        const Header = () => (
            <nav className="w-full bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between z-20 shadow-sm">
                <div className="flex items-center gap-4">
                    <img src="https://onramp.money/_app/immutable/assets/logo.D-_KihkR.svg" alt="Onramp" className="h-7" />
                    <span className="hidden md:inline text-sm font-semibold text-slate-600">Verification Agent</span>
                </div>
                <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                    <span className="text-xs font-bold text-slate-500 uppercase">Online</span>
                </div>
            </nav>
        );

        function App() {
            const [appState, setAppState] = useState("SETUP"); 
            const [kycStatus, setKycStatus] = useState("PENDING");
            const [sessionId, setSessionId] = useState(null);
            
            const [transcript, setTranscript] = useState("");
            const [aiMessage, setAiMessage] = useState("");
            const [isAiSpeaking, setIsAiSpeaking] = useState(false);
            const [isMicActive, setIsMicActive] = useState(false);
            const [isProcessing, setIsProcessing] = useState(false);
            
            const [selectedLang, setSelectedLang] = useState('en-IN');

            const videoRef = useRef(null);
            const recognitionRef = useRef(null);
            const synthRef = useRef(window.speechSynthesis);

            useEffect(() => {
                initCamera();
                if (speechSynthesis.onvoiceschanged !== undefined) {
                    speechSynthesis.onvoiceschanged = () => synthRef.current.getVoices();
                }
            }, []);

            useEffect(() => {
                // Re-init speech recognition when language changes
                initSpeechRecognition();
            }, [selectedLang]);

            const initCamera = async () => {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                    if (videoRef.current) videoRef.current.srcObject = stream;
                } catch (err) {
                    alert("Camera access required.");
                }
            };

            const initSpeechRecognition = () => {
                const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
                if (!SpeechRecognition) return;

                if (recognitionRef.current) recognitionRef.current.abort();

                const recognition = new SpeechRecognition();
                recognition.lang = selectedLang;
                recognition.continuous = false;
                recognition.interimResults = false;

                recognition.onstart = () => setIsMicActive(true);
                recognition.onend = () => setIsMicActive(false);
                
                recognition.onresult = (event) => {
                    const text = event.results[0][0].transcript;
                    if (text.trim().length > 0) handleUserResponse(text);
                };
                
                recognition.onerror = (e) => {
                    if (e.error === 'no-speech' && appState === 'ACTIVE' && !isAiSpeaking && !isProcessing) {
                       try { recognition.start(); } catch(e){}
                    }
                };

                recognitionRef.current = recognition;
            };

            const handleStartSession = async () => {
                setAppState("ACTIVE");
                try {
                    const res = await fetch('/api/start', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ language: selectedLang })
                    });
                    const data = await res.json();
                    
                    setSessionId(data.sessionId);
                    setAiMessage(data.spoken_response);
                    speakText(data.spoken_response);
                } catch (err) {
                    alert("Connection failed. Refresh page.");
                }
            };

            const handleUserResponse = async (text) => {
                setTranscript(text);
                setIsProcessing(true);
                if (recognitionRef.current) recognitionRef.current.stop();

                try {
                    const res = await fetch('/api/process', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sessionId, userText: text })
                    });
                    const data = await res.json();

                    setIsProcessing(false);
                    setAiMessage(data.spoken_response);
                    
                    if (data.status !== 'CONTINUE') {
                        setKycStatus(data.status);
                        setAppState("COMPLETED");
                        speakText(data.spoken_response, true);
                    } else {
                        speakText(data.spoken_response);
                    }

                } catch (err) {
                    setIsProcessing(false);
                    speakText("Connection error. Repeating last question.");
                }
            };

            const speakText = (text, isFinal = false) => {
                if (recognitionRef.current) recognitionRef.current.abort();
                setIsAiSpeaking(true);
                synthRef.current.cancel();

                const utterance = new SpeechSynthesisUtterance(text);
                const voices = synthRef.current.getVoices();
                const preferredVoice = voices.find(v => 
                    (v.name.includes("Google") || v.name.includes("Microsoft")) && 
                    v.lang.includes(selectedLang.split('-')[0])
                );
                
                if (preferredVoice) utterance.voice = preferredVoice;
                utterance.rate = 1.0; 
                utterance.pitch = 1.0; 

                utterance.onend = () => {
                    setIsAiSpeaking(false);
                    if (!isFinal && appState !== "COMPLETED") {
                        try { recognitionRef.current.start(); } catch(e){}
                    }
                };
                synthRef.current.speak(utterance);
            };

            const handleEndSession = () => {
                synthRef.current.cancel();
                if (recognitionRef.current) recognitionRef.current.abort();
                setAppState("SETUP");
                setSessionId(null);
                setKycStatus("PENDING");
                setAiMessage("");
                setTranscript("");
            };

            return (
                <div className="flex flex-col h-full bg-slate-50">
                    <Header />
                    <main className="flex-1 flex flex-col items-center justify-center p-4">
                        <div className="w-full max-w-2xl bg-white rounded-2xl shadow-xl overflow-hidden border border-slate-200">
                            <div className="relative aspect-video bg-black">
                                <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover video-mirror opacity-90"></video>
                                <div className="absolute top-4 right-4 flex gap-2">
                                    {appState === 'ACTIVE' && (
                                        <div className="flex items-center gap-2 bg-black/60 backdrop-blur text-white px-3 py-1 rounded-full text-xs font-bold border border-white/10">
                                            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>REC
                                        </div>
                                    )}
                                </div>
                                <div className="absolute bottom-0 inset-x-0 p-6 bg-gradient-to-t from-black/90 to-transparent">
                                    <div className="text-center min-h-[3rem] flex items-end justify-center">
                                        {isAiSpeaking ? (
                                            <p className="text-white font-medium text-lg leading-snug drop-shadow-md">"{aiMessage}"</p>
                                        ) : isProcessing ? (
                                            <div className="flex items-center gap-2 text-blue-300 font-semibold">Analyzing Response...</div>
                                        ) : isMicActive ? (
                                            <div className="flex flex-col items-center">
                                                <p className="text-emerald-400 font-bold tracking-wider mb-1">LISTENING</p>
                                                <p className="text-slate-400 text-xs">{transcript || "Speak now..."}</p>
                                            </div>
                                        ) : appState === 'SETUP' ? (
                                            <p className="text-slate-300 text-sm">Select Language & Start</p>
                                        ) : (
                                            <p className={"font-bold text-xl " + (kycStatus === 'APPROVED' ? "text-green-400" : "text-red-400")}>
                                                {kycStatus === 'APPROVED' ? '✅ Verification Successful' : '❌ Verification Rejected'}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            </div>
                            <div className="p-6 bg-white">
                                {appState === 'SETUP' ? (
                                    <div className="flex flex-col gap-4">
                                        <div className="flex gap-4">
                                            {['en-IN', 'hi-IN'].map(lang => (
                                                <button key={lang} onClick={() => setSelectedLang(lang)}
                                                    className={"flex-1 py-4 rounded-xl border-2 font-bold text-sm transition-all " + 
                                                    (selectedLang === lang ? "border-blue-600 bg-blue-50 text-blue-700" : "border-slate-100 text-slate-500 hover:border-slate-300")}>
                                                    {lang === 'en-IN' ? '🇬🇧 English' : '🇮🇳 Hindi'}
                                                </button>
                                            ))}
                                        </div>
                                        <button onClick={handleStartSession} className="w-full py-4 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-lg shadow-blue-200 transition-all active:scale-[0.98]">
                                            Start Verification
                                        </button>
                                    </div>
                                ) : (
                                    <div className="flex items-center justify-between">
                                        <div className="text-sm">
                                            <span className="text-slate-500">Session ID:</span>
                                            <span className="font-mono text-slate-700 ml-2">{sessionId}</span>
                                        </div>
                                        <button onClick={handleEndSession} className="px-6 py-2 bg-red-50 text-red-600 border border-red-100 font-semibold rounded-lg hover:bg-red-100 transition-colors">
                                            {appState === 'COMPLETED' ? 'Restart' : 'End Call'}
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                    </main>
                </div>
            );
        }
        const root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(<App />);
    </script>
</body>
</html>
`;
