import express from "express";
import cors from "cors";
import "dotenv/config";

const app = express();
app.use(cors({
    origin: "http://localhost:8080",
    methods: ["POST"],
    allowedHeaders: ["Content-Type"],
}));
app.use(express.json());

const PORT = 3000;
const clientId = process.env.MAL_CLIENT_ID;
const clientSecret = process.env.MAL_CLIENT_SECRET;

app.post("/api/auth/mal/callback", async (req, res) => {
    try {
        const { code, verifier, redirectUri } = req.body;

        if (!code || !verifier || !redirectUri || !clientId || !clientSecret) {
            res.status(400).json({ error: "Missing required parameters" });
            return;
        }

        const body = new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: "authorization_code",
            code: code,
            // redirect_uri: redirectUri,
            code_verifier: verifier
        })

        const response = await fetch(
            "https://myanimelist.net/v1/oauth2/token",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body,
            }
        );
        
        const responseText = await response.text();

        if (!response.ok) {
            console.error(
                "MAL token exchange failed:",
                response.status,
                responseText
            );

            res.status(502).json({
                error: "MAL token exchange failed",
                upstreamStatus: response.status,
            });
            return;
        }

        const data = JSON.parse(responseText);

        res.json(data);
        console.log(data);
    } catch (error) {
        console.error("OAuth callback failed:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.listen(PORT, () => {
    console.log(`Tracker API running on http://localhost:${PORT}`);
})