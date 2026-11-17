import http from 'node:http';

const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ service: 'boundary-matrix-demo', healthy: true }));
});
server.listen(8080, '0.0.0.0');
