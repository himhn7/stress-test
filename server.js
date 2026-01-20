const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Store test results for report generation
let lastTestResults = null;

// Store active SSE clients
let sseClients = [];

// Store active test state
let activeTest = null;

// SSE endpoint for real-time progress
app.get('/api/stress-test/progress', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const clientId = Date.now();
    const newClient = { id: clientId, res };
    sseClients.push(newClient);

    req.on('close', () => {
        sseClients = sseClients.filter(client => client.id !== clientId);
    });
});

// Helper function to send progress updates
function sendProgress(data) {
    sseClients.forEach(client => {
        client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    });
}

// Stop test endpoint
app.post('/api/stress-test/stop', (req, res) => {
    if (activeTest) {
        activeTest.shouldStop = true;
        res.json({ success: true, message: 'Test stop requested' });
    } else {
        res.status(400).json({ error: 'No active test to stop' });
    }
});

// Helper function to make a single request
async function makeRequest(method, endpoint, headers, body, timeout) {
    const requestStartTime = Date.now();
    try {
        const response = await axios({
            method,
            url: endpoint,
            headers,
            data: body,
            timeout,
            validateStatus: () => true
        });
        return {
            success: true,
            statusCode: response.status,
            responseTime: Date.now() - requestStartTime,
            size: JSON.stringify(response.data).length
        };
    } catch (error) {
        return {
            success: false,
            statusCode: error.response?.status || 0,
            responseTime: Date.now() - requestStartTime,
            error: error.code || error.message,
            size: 0
        };
    }
}

// Calculate summary helper
function calculateSummary(results, startTime) {
    const currentTime = Date.now();
    const elapsedTime = currentTime - startTime;
    const successCount = results.responses.filter(r => r.success).length;
    const failCount = results.responses.filter(r => !r.success).length;
    const responseTimes = results.responses.map(r => r.responseTime);
    const avgResponseTime = responseTimes.length > 0 
        ? (responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length).toFixed(2)
        : 0;
    const currentRPS = elapsedTime > 0 
        ? ((results.responses.length / elapsedTime) * 1000).toFixed(2)
        : 0;
    
    return {
        successCount,
        failCount,
        avgResponseTime,
        currentRPS,
        elapsedTime
    };
}

// Stress test endpoint with true concurrency
app.post('/api/stress-test', async (req, res) => {
    const {
        endpoint,
        method = 'GET',
        headers = {},
        body = null,
        totalRequests = 100,
        concurrency = 10,
        timeout = 30000
    } = req.body;

    if (!endpoint) {
        return res.status(400).json({ error: 'Endpoint is required' });
    }

    const results = {
        endpoint,
        method,
        totalRequests,
        concurrency,
        startTime: new Date().toISOString(),
        responses: [],
        summary: {}
    };

    const startTime = Date.now();
    
    // Initialize active test state
    activeTest = {
        shouldStop: false,
        results
    };

    let requestsSent = 0;
    let requestsCompleted = 0;
    const activeRequests = new Set();

    // Function to send progress updates
    const sendProgressUpdate = () => {
        const stats = calculateSummary(results, startTime);
        sendProgress({
            type: 'progress',
            completed: requestsCompleted,
            total: totalRequests,
            percentage: ((requestsCompleted / totalRequests) * 100).toFixed(1),
            successCount: stats.successCount,
            failCount: stats.failCount,
            avgResponseTime: stats.avgResponseTime,
            currentRPS: stats.currentRPS,
            elapsedTime: stats.elapsedTime
        });
    };

    // Function to start a new request
    const startRequest = async () => {
        if (requestsSent >= totalRequests || activeTest.shouldStop) {
            return;
        }

        requestsSent++;
        const requestPromise = makeRequest(method, endpoint, headers, body, timeout)
            .then(result => {
                results.responses.push(result);
                requestsCompleted++;
                activeRequests.delete(requestPromise);
                
                // Send progress update
                sendProgressUpdate();
                
                // Start next request to maintain concurrency
                if (!activeTest.shouldStop && requestsSent < totalRequests) {
                    startRequest();
                }
            });

        activeRequests.add(requestPromise);
    };

    // Start initial batch of concurrent requests
    const initialBatch = Math.min(concurrency, totalRequests);
    for (let i = 0; i < initialBatch; i++) {
        startRequest();
    }

    // Wait for all requests to complete or stop signal
    while (activeRequests.size > 0 || (requestsCompleted < requestsSent && !activeTest.shouldStop)) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    const endTime = Date.now();
    const totalTime = endTime - startTime;

    // Calculate summary statistics
    const successfulResponses = results.responses.filter(r => r.success);
    const failedResponses = results.responses.filter(r => !r.success);
    const responseTimes = results.responses.map(r => r.responseTime);

    results.summary = {
        totalTime,
        totalRequests: results.responses.length,
        successfulRequests: successfulResponses.length,
        failedRequests: failedResponses.length,
        successRate: ((successfulResponses.length / results.responses.length) * 100).toFixed(2),
        avgResponseTime: (responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length).toFixed(2),
        minResponseTime: Math.min(...responseTimes),
        maxResponseTime: Math.max(...responseTimes),
        requestsPerSecond: ((results.responses.length / totalTime) * 1000).toFixed(2),
        statusCodes: {},
        errors: {}
    };

    // Count status codes
    results.responses.forEach(r => {
        const code = r.statusCode || 'No Response';
        results.summary.statusCodes[code] = (results.summary.statusCodes[code] || 0) + 1;
        if (r.error) {
            results.summary.errors[r.error] = (results.summary.errors[r.error] || 0) + 1;
        }
    });

    // Calculate percentiles
    const sortedTimes = [...responseTimes].sort((a, b) => a - b);
    results.summary.p50 = sortedTimes[Math.floor(sortedTimes.length * 0.5)];
    results.summary.p90 = sortedTimes[Math.floor(sortedTimes.length * 0.9)];
    results.summary.p95 = sortedTimes[Math.floor(sortedTimes.length * 0.95)];
    results.summary.p99 = sortedTimes[Math.floor(sortedTimes.length * 0.99)];

    results.endTime = new Date().toISOString();
    results.stopped = activeTest.shouldStop;
    lastTestResults = results;
    
    // Clear active test
    activeTest = null;

    res.json(results);
});

// Generate markdown report
app.post('/api/generate-report', (req, res) => {
    if (!lastTestResults) {
        return res.status(400).json({ error: 'No test results available. Run a stress test first.' });
    }

    const results = lastTestResults;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `stress-test-report-${timestamp}.md`;

    const markdown = `# API Stress Test Report

## Test Configuration
| Parameter | Value |
|-----------|-------|
| Endpoint | \`${results.endpoint}\` |
| Method | ${results.method} |
| Total Requests | ${results.totalRequests} |
| Concurrency | ${results.concurrency} |
| Start Time | ${results.startTime} |
| End Time | ${results.endTime} |

## Summary Results

### Performance Metrics
| Metric | Value |
|--------|-------|
| Total Time | ${results.summary.totalTime}ms |
| Requests/Second | ${results.summary.requestsPerSecond} |
| Avg Response Time | ${results.summary.avgResponseTime}ms |
| Min Response Time | ${results.summary.minResponseTime}ms |
| Max Response Time | ${results.summary.maxResponseTime}ms |

### Response Time Percentiles
| Percentile | Time (ms) |
|------------|-----------|
| P50 (Median) | ${results.summary.p50} |
| P90 | ${results.summary.p90} |
| P95 | ${results.summary.p95} |
| P99 | ${results.summary.p99} |

### Success Rate
| Metric | Value |
|--------|-------|
| Successful Requests | ${results.summary.successfulRequests} |
| Failed Requests | ${results.summary.failedRequests} |
| Success Rate | ${results.summary.successRate}% |

### Status Code Distribution
| Status Code | Count |
|-------------|-------|
${Object.entries(results.summary.statusCodes).map(([code, count]) => `| ${code} | ${count} |`).join('\n')}

${Object.keys(results.summary.errors).length > 0 ? `### Errors
| Error | Count |
|-------|-------|
${Object.entries(results.summary.errors).map(([error, count]) => `| ${error} | ${count} |`).join('\n')}` : ''}

---
*Report generated at ${new Date().toISOString()}*
`;

    // Save to reports directory
    const reportsDir = path.join(__dirname, 'reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }

    const filepath = path.join(reportsDir, filename);
    fs.writeFileSync(filepath, markdown);

    res.json({
        success: true,
        filename,
        filepath,
        content: markdown
    });
});

// Get list of reports
app.get('/api/reports', (req, res) => {
    const reportsDir = path.join(__dirname, 'reports');
    if (!fs.existsSync(reportsDir)) {
        return res.json({ reports: [] });
    }

    const files = fs.readdirSync(reportsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => ({
            name: f,
            path: path.join(reportsDir, f),
            created: fs.statSync(path.join(reportsDir, f)).birthtime
        }))
        .sort((a, b) => new Date(b.created) - new Date(a.created));

    res.json({ reports: files });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Stress Test Server running on http://localhost:${PORT}`);
});
