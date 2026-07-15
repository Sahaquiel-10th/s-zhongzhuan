import http from 'node:http';

const port = Number(process.env.MOCK_UPSTREAM_PORT || 4199);

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === '/v1/chat/completions' && body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"mock","model":"private-model-v1","choices":[{"delta":{"content":"测试"}}]}\n\n');
      res.write('data: {"id":"mock","model":"private-model-v1","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":200,"prompt_tokens_details":{"cached_tokens":600}}}\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'mock',
        model: 'private-model-v1',
        choices: [{ message: { role: 'assistant', content: '测试响应' } }],
        usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 600 } },
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
});

server.listen(port, '127.0.0.1', () => console.log(`mock upstream: http://127.0.0.1:${port}/v1`));
