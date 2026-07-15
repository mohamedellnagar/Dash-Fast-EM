// Minimal local stand-in for FastTest — for LOCAL multi-worker verification
// only. Never used in production. Responds to auth/status/results.
const http = require('http');
const port = Number(process.env.MOCK_PORT || 3999);

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/auth/simple')) {
      res.end(JSON.stringify({ apiToken: 'MOCK-TOKEN', ttl: 3600, workspaceName: 'Mock' }));
    } else if (req.url.includes('/status')) {
      res.end(JSON.stringify({ status: 'COMPLETED', testId: 1, examineeId: 2 }));
    } else if (req.url.includes('/results')) {
      res.end(JSON.stringify({ examineeRegistrationResults: [{ testName: 'M', secondsUsed: 600, passed: true, scores: [{ rawScore: 10, scaledScore: 200, scoredItems: { correct: 8, incorrect: 2, skipped: 0 }, totalItems: { correct: 8, incorrect: 2, skipped: 0 } }] }] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
});
server.listen(port, () => console.log(`mock-fasttest on :${port}`));
