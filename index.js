const express = require('express');
const app = express();
const port = process.env.PORT || 3001; // Render will set the PORT env variable

// A simple route for testing
app.get('/', (req, res) => {
  res.send('Vidzly Backend is Alive and Kicking!');
});

// Example of a potential API endpoint for your Vidzly app
// This is just a placeholder for now.
app.get('/api/sample', (req, res) => {
  res.json({ message: 'This is a sample API response from your backend!' });
});

app.listen(port, () => {
  console.log(`Vidzly backend listening on http://localhost:${port}`);
});