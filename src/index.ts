import { oauth, handleOAuthCallback } from "./oauth.js";

const loginButton = document.querySelector<HTMLButtonElement>("#login")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;

loginButton.addEventListener("click", () => {
    oauth();
});

async function main() {
    const params = new URL(window.location.href).searchParams;

    if (params.has("code") || params.has("error")) {
        loginButton.disabled = true;
        status.textContent = "Completing MAL authorization...";

        try {
            await handleOAuthCallback();
            status.textContent = "MAL authorization succeeded!";
        } catch (error) {
            status.textContent = `Authorization failed: ${
                error instanceof Error ? error.message : String(error)
            }`;
        }
    }
}

void main();