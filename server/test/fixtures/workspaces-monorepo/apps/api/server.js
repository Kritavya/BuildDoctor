const http = require('node:http');
const { greet } = require('@demo/shared');

const port = process.env.PORT || 4000;
http.createServer((req, res) => res.end(greet('api'))).listen(port, '0.0.0.0', () => console.log(`api listening on ${port}`));
