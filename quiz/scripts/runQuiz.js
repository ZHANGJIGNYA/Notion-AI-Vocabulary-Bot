// scripts/runQuiz.js


async function main() {
    try {
        console.log("🚀 Starting MCQ Quiz Generation...");

        const databaseId = process.env.NOTION_DB_ID;
        const notionToken = process.env.NOTION_TOKEN;
        const geminiApiKey = process.env.GEMINI_API_KEY;

        if (!databaseId || !notionToken || !geminiApiKey) {
            throw new Error("❌ Missing Environment Variables!");
        }

        // 1. 筛选 Notion (找 Review Stage > 0 的单词)
        const queryResp = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${notionToken}`,
                "Notion-Version": "2022-06-28",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                page_size: 5, // 每次出 5 题
                filter: {
                    and: [
                        { property: "Review Stage", number: { greater_than: 0 } }
                    ]
                }
            })
        });

        const data = await queryResp.json();
        let wordsToQuiz = data.results || [];

        // --- 修复点 1: 日期过滤 (替换掉 ?. 写法) ---
        const todayStr = new Date().toISOString().split('T')[0];

        wordsToQuiz = wordsToQuiz.filter(p => {
            const lastQuiz = p.properties["Last Quiz"];
            // 如果没有 Last Quiz 属性，或者没有日期，视为“没做过”，保留
            if (!lastQuiz || !lastQuiz.date) {
                return true;
            }
            // 如果有日期，判断是否“不是今天”
            return lastQuiz.date.start !== todayStr;
        });

        // 随机打乱
        wordsToQuiz.sort(() => 0.5 - Math.random());

        if (wordsToQuiz.length === 0) {
            console.log("✅ No words need quizzing today.");
            return;
        }

        console.log(`📝 Processing ${wordsToQuiz.length} words into MCQs...`);

        // 2. 循环出题
        for (const page of wordsToQuiz) {

            // --- 修复点 2: 获取单词 (替换掉 ?. 写法) ---
            let word = null;
            const nameProp = page.properties["Name"];
            if (nameProp && nameProp.title && nameProp.title.length > 0) {
                word = nameProp.title[0].plain_text;
            }

            if (!word) continue;

            // 随机题型
            const quizTypes = ["sentence", "definition", "thesaurus"];
            const selectedType = quizTypes[Math.floor(Math.random() * quizTypes.length)];

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
                (Distractors must be same part of speech, plausible but clearly wrong contextually).`;
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

            prompt += ` STRICT JSON ONLY. No Markdown.`;

            // 调用 Gemini
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;
            const geminiResp = await fetch(geminiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
            });

            const gData = await geminiResp.json();

            // --- 修复点 3: 获取 AI 回复 (替换掉 ?. 写法) ---
            let aiText = "{}";
            if (gData && gData.candidates && gData.candidates.length > 0) {
                const firstCandidate = gData.candidates[0];
                if (firstCandidate.content && firstCandidate.content.parts && firstCandidate.content.parts.length > 0) {
                    aiText = firstCandidate.content.parts[0].text || "{}";
                }
            }

            aiText = aiText.replace(/```json/g, "").replace(/```/g, "").trim();

            let quizData = {};
            try {
                quizData = JSON.parse(aiText);
            } catch (e) {
                console.error("⚠️ JSON Parse Error", e);
                continue;
            }

            // --- 🔀 洗牌逻辑 (Shuffle Options) ---
            // 确保 distractors 存在，防止报错
            if (!quizData.distractors || quizData.distractors.length < 3) {
                console.log("   ⚠️ Skipping due to insufficient distractors.");
                continue;
            }

            // 1. 把正确答案和干扰项放在一起
            let options = [
                { text: quizData.correct, isCorrect: true },
                { text: quizData.distractors[0], isCorrect: false },
                { text: quizData.distractors[1], isCorrect: false },
                { text: quizData.distractors[2], isCorrect: false }
            ];

            // 2. 随机打乱数组
            options.sort(() => Math.random() - 0.5);

            // 3. 格式化成 ABCD 文本
            const labels = ["A", "B", "C", "D"];
            let questionText = quizData.question + "\n\n"; // 题目部分
            let correctLabel = "";

            options.forEach((opt, index) => {
                const label = labels[index];
                questionText += `${label}. ${opt.text}\n`; // 拼接 A. word
                if (opt.isCorrect) correctLabel = label; // 记录哪个字母是对的
            });

            // 4. 写入 Notion
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
                            rich_text: [{ text: { content: correctLabel } }] // 这里的 Key 变成了 "A", "B"...
                        },
                        "✏️ My Answer": { rich_text: [] } // 清空你的答案
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