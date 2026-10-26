const clientId = "0e6a4bcb109c4239c63f77d8ccc02b85"
const PORT = 8080;
const redirectUri = `http://localhost:${PORT}`;

export function oauth() {
    window.location.href = generateUrl();
    // const url = generateUrl();
    // console.log(url);
}

function generateUrl(): string {
    const verifier = generateCodeVerifier(64);
    const state = generateCodeVerifier(16);

    sessionStorage.setItem("verifier", verifier);
    sessionStorage.setItem("oauth_state", state);


    if (!clientId) {
        throw new Error("Missing MAL_CLIENT_ID");
    }
    
    const params = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        state: state,
        // redirect_uri: redirectUri,
        code_challenge: verifier,
        code_challenge_method: "plain",
    });

    return `https://myanimelist.net/v1/oauth2/authorize?${params}`;
}

export function generateCodeVerifier(byteLength: number): string {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);

    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

interface MALTokens {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
}

export async function handleOAuthCallback(): Promise<MALTokens> {
    const callbackUrl = new URL(window.location.href)
    const callbackParams = callbackUrl.searchParams;

    const oauthError = callbackParams.get("error");
    if (oauthError) {
        throw new Error(`MAL authorization failed: ${oauthError}`);
    }

    const code = callbackParams.get("code");
    const state = callbackParams.get("state");
    if (!code || !state) {
        throw new Error("Missing authorization code or state");
    }

    const expectedState = sessionStorage.getItem("oauth_state");
    if (!expectedState || state != expectedState) {
        throw new Error("OAuth state mismatch");
    }

    const verifier = sessionStorage.getItem("verifier");
    if (!verifier) {
        throw new Error("Missing PKCE code verifier");
    }

    const response = await fetch(
        "http://localhost:3000/api/auth/mal/callback",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                code,
                verifier,
                redirectUri,
            }),
        }
    );

    if (!response.ok) {
        throw new Error("Token exchange failed");
    }

    const tokens: MALTokens = await response.json();
    return tokens;

    // // no cors

    // const body = new URLSearchParams({
    //     client_id: clientId,
    //     grant_type: "authorization_code",
    //     code: code,
    //     // redirect_uri: redirectUri,
    //     code_verifier: verifier
    // });

    // const response = await fetch(
    //     "https://myanimelist.net/v1/oauth2/token",
    //     {
    //         method: "POST",
    //         headers: {
    //             "Content-Type": "application/x-www-form-urlencoded",
    //         },
    //         body,
    //     }
    // );

    // const tokens = (await response.json()) as MALTokens;

    // if (!tokens.access_token || !tokens.refresh_token) {
    //     throw new Error("MAL did not return the expected tokens");
    // }

    // sessionStorage.removeItem("verifier");
    // sessionStorage.removeItem("oauth_state");

    // // Remove OAuth parameters from the visible URL.
    // window.history.replaceState(
    //     {},
    //     document.title,
    //     callbackUrl.pathname
    // );

    // return tokens;
}