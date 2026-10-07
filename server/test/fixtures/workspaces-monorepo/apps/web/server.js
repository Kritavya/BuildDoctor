const http = require('node:http');
const { greet } = require('@demo/shared');
const { port } = require('./config/default.json');

const apiUrl = process.env.API_URL || 'http://localhost:4000';
http.createServer((req, res) => res.end(`${greet('web')} (api at ${apiUrl})`)).listen(port, '0.0.0.0', () => console.log(`web listening on ${port}`));
