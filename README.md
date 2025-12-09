# Onramp AI Video KYC Agent 📹🤖

A lightweight, single-file AI Agent that performs real-time Video KYC (Know Your Customer) interviews. It uses **Google Gemini** to act as a financial crime investigator, detecting fraud, coercion, and scams during a live video call.

## 🚀 Features

* **AI Interviewer:** Conducts dynamic interviews; does not follow a fixed script.
* **Fraud Detection:** Analyzes user answers for signs of "Pig Butchering" scams, money mules, or coercion.
* **Smart Model Discovery:** Automatically finds the best available Gemini model (Flash/Pro) to prevent 404 errors.
* **Voice-to-Voice:** Uses Browser Speech Synthesis and Recognition for a natural conversation.
* **Multi-Language:** Supports English (en-IN) and Hindi (hi-IN) with auto-switching.

## 🛠️ Tech Stack

* **Backend:** Node.js, Express
* **AI:** Google Gemini API
* **Frontend:** React (served via CDN for single-file portability)
* **Speech:** Web Speech API (Native Browser Support)

## 📦 Installation

1.  **Clone the repository**
    ```bash
    git clone [https://github.com/mrinal505/kyc.git](https://github.com/mrinal505/kyc.git)
    cd your-repo-name
    ```

2.  **Install Dependencies**
    ```bash
    npm install
    ```

3.  **Set up Environment Variables**
    * Create a `.env` file (optional for local, required for prod) OR set it in your terminal.
    * You need a Google Gemini API Key.

    **Mac/Linux:**
    ```bash
    export GEMINI_API_KEY="your_api_key_here"
    ```
    **Windows (Powershell):**
    ```powershell
    $env:GEMINI_API_KEY="your_api_key_here"
    ```

4.  **Run the Server**
    ```bash
    npm start
    ```

5.  **Open the App**
    * Visit `http://localhost:3000` in your browser.
    * *Note: Use Chrome or Safari. Firefox does not support the Speech API well.*

## ☁️ Deployment (Render.com)

1.  Push this code to **GitHub**.
2.  Go to **Render Dashboard** > **New Web Service**.
3.  Connect your repository.
4.  **Build Command:** `npm install`
5.  **Start Command:** `node server.js`
6.  **Environment Variables:**
    * Add `GEMINI_API_KEY` -> `[Your Actual Key]`
    * Add `NODE_VERSION` -> `18.17.0` (or higher)

## ⚠️ Important Notes

* **Microphone Access:** The browser will block the microphone if not served over `localhost` or `HTTPS`. When deploying, ensure your host provides SSL (Render does this automatically).
* **Data Persistence:** This is an MVP. Session data is stored in memory and will be lost if the server restarts.

## 🛡️ License

MIT
