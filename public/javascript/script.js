const mysql = require('mysql2/promise');
const express = require('express');
const app = express();
const PORT = 3000;

app.use(express.json());

app.use(express.static(__dirname));

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',         
  password: 'Password', 
  database: '',    
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

app.get('/api/users', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM user');
    res.json(rows); 
  } catch (error) {
    console.error('Error fetching users:', error.message);
    res.status(500).json({ error: 'Failed to fetch users from database' });
  }
});

app.post('/api/users', async (req, res) => {
  try {
    const { name } = req.body; 
    
    const [result] = await pool.query('INSERT INTO user (name) VALUES (?)', [name]);
    
    res.status(201).json({ message: 'User added successfully', userId: result.insertId });
  } catch (error) {
    console.error('Error inserting user:', error.message);
    res.status(500).json({ error: 'Failed to save user to database' });
  }
});


app.listen(PORT, () => {
  console.log(`Server is running! Open http://localhost:${PORT} in your browser.`);
});