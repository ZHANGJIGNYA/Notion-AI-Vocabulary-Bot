// quiz/scripts/runQuiz.js

// 移除 node-fetch 依赖，直接使用 Node 18 原生 fetch
// const fetch = require('node-fetch'); 

async function main() {
    try {
        console.log("🚀 Starting MCQ Quiz Generation (Robust Mode)...");

        const databaseId = process.env.NOTION_DB_ID;
        const notionToken = process.env.NOTION_TOKEN;
        const geminiApiKey = process.env.GEMINI_API_KEY;

        if (!databaseId || !notionToken || !geminiApiKey) {
            throw new Error("❌ Missing Environment Variables!");
        }

        // 1. 筛选 Notion
        const queryResp = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${notionToken}`,
                "Notion-Version": "2022-06-28",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                page_size: 5,
                filter: {
                    and: [
                        { property: "Review Stage", number: { greater_than: 0 } }
                    ]
                }
            })
        });

        const data = await queryResp.json();
        let wordsToQuiz = data.results || [];

        // 日期过滤
        const todayStr = new Date().toISOString().split('T')[0];

        wordsToQuiz = wordsToQuiz.filter(p => {
            const lastQuiz = p.properties["Last Quiz"];
            if (!lastQuiz || !lastQuiz.date) return true;
            return lastQuiz.date.start !== todayStr;
        });

        // 随机打乱
        wordsToQuiz.sort(() => 0.5 - Math.random());

        if (wordsToQuiz.length === 0) {
            console.log("✅ No words need quizzing today.");
            return;
        }

        console.log(`📝 Processing ${wordsToQuiz.length} words...`);

        // 2. 循环出题
        for (const page of wordsToQuiz) {

            let word = null;
            const nameProp = page.properties["Name"];
            if (nameProp && nameProp.title && nameProp.title.length > 0) {
                word = nameProp.title[0].plain_text;
            }

            if (!word) continue;

            // 随机题型
            const quizTypes = ["sentence", "definition", "thesaurus"];
            const selectedType = quizTypes[Math.floor(Math.random() * quizTypes.length)];

            console.log(`   - Generating [${selectedType}] for: "${word}"`);

            // 构造 Prompt
            let prompt = `Task: Create a Multiple Choice Quiz for the English word: "${word}". Type: ${selectedType}.`;

            if (selectedType === "sentence") {
                prompt += `
                Create a sentence where "${word}" fits perfectly, replacing it with "______".
                JSON Output: {
                    "question": "The sentence...",
                    "correct": "${word}",
                    "distractors": ["word1", "word2", "word3"]
                }
                (Distractors must be same part of speech, plausible but wrong).`;
            } else if (selectedType === "definition") {
                prompt += `
                Provide an English definition for "${word}".
                JSON Output: {
                    "question": "Definition: ...",
                    "correct": "${word}",
                    "distractors": ["word1", "word2", "word3"]
                }`;
            } else if (selectedType === "thesaurus") {
                prompt += `
                Provide synonyms for "${word}".
                JSON Output: {
                    "question": "Which word means: [synonyms]?",
                    "correct": "${word}",
                    "distractors": ["word1", "word2", "word3"]
                }`;
            }

            prompt += `
            IMPORTANT: Output RAW JSON only. Do not wrap in markdown blocks. 
            Ensure "distractors" is an array of 3 strings.
            `;

            // 调用 Gemini
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;
            const geminiResp = await fetch(geminiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
            });

            const gData = await geminiResp.json();

            // 获取 AI 回复 (防报错写法)
            let aiText = "{}";
            if (gData && gData.candidates && gData.candidates.length > 0) {
                const firstCandidate = gData.candidates[0];
                if (firstCandidate.content && firstCandidate.content.parts && firstCandidate.content.parts.length > 0) {
                    aiText = firstCandidate.content.parts[0].text || "{}";
                }
            }

            // 清洗 JSON
            aiText = aiText.replace(/```json/g, "").replace(/```/g, "").trim();

            let quizData = {};
            try {
                quizData = JSON.parse(aiText);
            } catch (e) {
                console.error("   ⚠️ JSON Parse Error. Raw output:", aiText);
                continue;
            }

            // --- 🛡️ 强力修复逻辑 (Robust Fix) ---

            // 1. 确保 correct 存在
            if (!quizData.correct) quizData.correct = word;
            if (!quizData.question) quizData.question = `Quiz for ${word}`;

            // 2. 确保 distractors 是数组
            if (!Array.isArray(quizData.distractors)) {
                quizData.distractors = [];
            }

            // 3. 强行补全干扰项 (如果不够 3 个，自动补 Random Option，绝不跳过)
            while (quizData.distractors.length < 3) {
                console.log("   ⚠️ AI missed a distractor. Auto-filling.");
                quizData.distractors.push("Incorrect Option");
            }

            // --- 🔀 洗牌逻辑 ---
            let options = [
                { text: quizData.correct, isCorrect: true },
                { text: quizData.distractors[0], isCorrect: false },
                { text: quizData.distractors[1], isCorrect: false },
                { text: quizData.distractors[2], isCorrect: false }
            ];

            options.sort(() => Math.random() - 0.5);

            const labels = ["A", "B", "C", "D"];
            let questionText = quizData.question + "\n\n";
            let correctLabel = "";

            options.forEach((opt, index) => {
                const label = labels[index];
                questionText += `${label}. ${opt.text}\n`;
                if (opt.isCorrect) correctLabel = label;
            });

            // 写入 Notion
            await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
                method: "PATCH",
                headers: {
                    "Authorization": `Bearer ${notionToken}`,
                    "Notion-Version": "2022-06-28",
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    properties: {
                        "❓ Question": {
                            rich_text: [{ text: { content: questionText } }]
                        },
                        "🔑 Answer Key": {
                            rich_text: [{ text: { content: correctLabel } }]
                        },
                        "✏️ My Answer": { rich_text: [] }
                    }
                })
            });
            console.log(`   ✅ Generated MCQ for ${word} (Ans: ${correctLabel})`);
        }

        console.log("🎉 All Done!");

    } catch (err) {
        console.error("❌ Fatal Error:", err);
        process.exit(1);
    }
}

main();