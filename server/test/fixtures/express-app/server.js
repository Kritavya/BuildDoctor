const express = require('express');

const app = express();
const port = process.env.PORT || 3000;
const greeting = process.env.GREETING || 'hello';

app.get('/', (_req, res) => res.json({ ok: true, greeting }));
app.get('/health', (_req, res) => res.send('ok'));

app.listen(port, () => console.log(`listening on ${port}`));
