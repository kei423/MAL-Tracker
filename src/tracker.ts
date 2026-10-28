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

interface MALTokens {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
}

let malTokens: MALTokens | null = null;

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
        
        malTokens = data;

        res.json({ success: true });
        
        console.log(data);
    } catch (error) {
        console.error("OAuth callback failed:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.get("/api/mal/animelist", async (req, res) => {
    if (!malTokens) {
        res.status(401).json({
            error: "Please authorize with MAL first"
        });
        return;
    }

    try {
        const response = await fetch(
            "https://api.myanimelist.net/v2/users/@me/animelist?fields=list_status&limit=10", 
            {
                headers: {
                    Authorization: `Bearer ${malTokens.access_token}`,
                },
            }
        );

        if (!response.ok) {
            res.status(response.status).json({
                error: "Failed to retrieve anime list from MAL"
            });
            return;
        }

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error("Anime list request failed:", error);
        res.status(500).json({
            error: "Internal server error",
        });
    }
});

app.listen(PORT, () => {
    console.log(`Tracker API running on http://localhost:${PORT}`);
})