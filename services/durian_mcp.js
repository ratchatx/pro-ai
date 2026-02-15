
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '../durian_harvests.json');

// Ensure DB exists
if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify([], null, 2));
}

function loadData() {
    try {
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch (e) {
        return [];
    }
}

function saveData(data) {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

export const definitions = [
    {
        type: "function",
        function: {
            name: "record_harvest",
            description: "Record durian harvest data including count, weight, and date.",
            parameters: {
                type: "object",
                properties: {
                    count: { type: "number", description: "Number of durians harvested (ลูก)" },
                    weight: { type: "number", description: "Total weight in kg (กิโลกรัม)" },
                    date: { type: "string", description: "Date of harvest in YYYY-MM-DD format" }
                },
                required: ["count", "weight", "date"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_harvest_stats",
            description: "Get harvest statistics and generate a Flex Message with monthly graph.",
            parameters: {
                type: "object",
                properties: {
                    year: { type: "integer", description: "The year to display stats for (e.g., 2024). Defaults to current year if not specified." }
                }
            }
        }
    }
];

export const handlers = {
    async record_harvest({ count, weight, date }) {
        const data = loadData();
        data.push({
            id: Date.now().toString(),
            count,
            weight,
            date, // YYYY-MM-DD
            timestamp: new Date().toISOString()
        });
        saveData(data);
        return { 
            status: "success", 
            message: `บันทึกข้อมูลทุเรียน ${count} ลูก น้ำหนัก ${weight} กก. วันที่ ${date} เรียบร้อยแล้ว` 
        };
    },

    async get_harvest_stats({ year }) {
        const targetYear = year || new Date().getFullYear();
        const data = loadData();
        
        // Filter by year
        const yearlyData = data.filter(d => d.date.startsWith(String(targetYear)));
        
        if (yearlyData.length === 0) {
            return { 
                status: "empty", 
                message: `ไม่พบข้อมูลการเก็บเกี่ยวในปี ${targetYear}` 
            };
        }

        // Aggregate Monthly
        const months = {}; // "01": 100
        let totalWeight = 0;
        let totalCount = 0;

        yearlyData.forEach(d => {
            const m = d.date.split('-')[1];
            if (!months[m]) months[m] = 0;
            months[m] += d.weight;
            totalWeight += d.weight;
            totalCount += d.count;
        });

        const sortedMonths = Object.keys(months).sort();
        const labels = sortedMonths.map(m => {
            const date = new Date(targetYear, parseInt(m) - 1, 1);
            return date.toLocaleString('th-TH', { month: 'short' });
        });
        const values = sortedMonths.map(m => months[m]);

        // QuickChart URL
        const chartConfig = {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'น้ำหนัก (กก.)',
                    data: values,
                    backgroundColor: 'rgba(54, 162, 235, 0.5)',
                    borderColor: 'rgb(54, 162, 235)',
                    borderWidth: 1
                }]
            },
            options: {
                plugins: {
                    datalabels: { display: true, anchor: 'en    d', align: 'top' }
                }
            }
        };
        const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=500&h=300`;

        // Create Flex Message
        const flexMessage = {
            type: "flex",
            altText: `สรุปยอดทุเรียนปี ${targetYear}`,
            contents: {
                type: "bubble",
                header: {
                    type: "box",
                    layout: "vertical",
                    contents: [
                        { type: "text", text: "สรุปผลผลิตทุเรียน", weight: "bold", size: "xl", color: "#2c3e50" },
                        { type: "text", text: `ประจำปี ${targetYear}`, size: "sm", color: "#7f8c8d" }
                    ]
                },
                hero: {
                    type: "image",
                    url: chartUrl,
                    size: "full",
                    aspectRatio: "1.618:1",
                    aspectMode: "cover"
                },
                body: {
                    type: "box",
                    layout: "vertical",
                    contents: [
                        {
                            type: "box",
                            layout: "horizontal",
                            contents: [
                                { type: "text", text: "น้ำหนักรวม", size: "sm", color: "#555555" },
                                { type: "text", text: `${totalWeight.toLocaleString()} กก.`, size: "sm", color: "#111111", align: "end", weight: "bold" }
                            ]
                        },
                        {
                            type: "box",
                            layout: "horizontal",
                            contents: [
                                { type: "text", text: "จำนวนลูก", size: "sm", color: "#555555" },
                                { type: "text", text: `${totalCount.toLocaleString()} ลูก`, size: "sm", color: "#111111", align: "end", weight: "bold" }
                            ],
                            margin: "md"
                        }
                    ]
                }
            }
        };

        return {
            status: "success",
            message: "สร้างกราฟสรุปยอดเรียบร้อยแล้ว",
            flexMessage: flexMessage
        };
    }
};
