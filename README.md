# API Stress Tester

A local tool for stress testing API endpoints with configurable load and detailed reporting.

## Features

- **Configurable API Testing**: Set endpoint, HTTP method, headers, authentication tokens, and request body
- **Load Configuration**: Control total requests and concurrency level
- **Real-time Results**: View performance metrics in the browser
- **Markdown Reports**: Generate detailed test reports saved to the `reports/` folder

## Installation

```bash
npm install
```

## Usage

1. Start the server:
```bash
npm start
```

2. Open your browser to: http://localhost:3001

3. Configure your test:
   - Enter the API endpoint URL
   - Select HTTP method (GET, POST, PUT, PATCH, DELETE)
   - Add headers (JSON format) - include API keys, Bearer tokens, etc.
   - Add request body (JSON format) for POST/PUT/PATCH requests
   - Set total number of requests
   - Set concurrency (parallel requests at a time)
   - Set timeout per request

4. Click "Run Stress Test" to execute

5. Click "Generate Report" to save a Markdown report to the `reports/` folder

## Metrics Provided

- Requests per second
- Success rate
- Average, min, max response times
- Response time percentiles (P50, P90, P95, P99)
- Status code distribution
- Error breakdown

## Reports

Reports are saved as Markdown files in the `reports/` directory with timestamps.
