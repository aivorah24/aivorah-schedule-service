require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'aivorah-schedule-service' }));

app.use('/schedule', require('./routes/schedule'));
app.use('/timetable', require('./routes/timetable'));

const PORT = process.env.PORT || 3009;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Aivorah Schedule service running on http://localhost:${PORT}`);
  });
}

module.exports = app;
