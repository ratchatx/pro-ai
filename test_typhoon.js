import dotenv from 'dotenv';
dotenv.config();

const API_KEY = process.env.TYPHOON_API_KEY || "sk-Ugp2OuKpCEfuna8201OisRpqZl477xT3CL10g8Jl1sHzvnYX";
const BASE_URL = "https://api.opentyphoon.ai/v1/models";

async function listModels() {
    try {
        console.log("Listing models...");
        const response = await fetch(BASE_URL, {
            headers: {
                "Authorization": `Bearer ${API_KEY}`
            }
        });

        console.log("Status:", response.status);
        const text = await response.text();
        console.log("Body:", text);

    } catch (error) {
        console.error("Fetch Error:", error);
    }
}

listModels();
