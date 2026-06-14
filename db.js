const sql = require("mssql");

const config = {
    user: process.env.DB_USER     || "dev_login",
    password: process.env.DB_PASS || "Dev12345!",
    server: process.env.DB_SERVER || "VbuildProd1",
    database: process.env.DB_NAME || "DevReportsDB",
    options: {
        trustServerCertificate: true,
        encrypt: false
    }
};

async function getPool() {
    try {
        const pool = await sql.connect(config);
        console.log("Connected to SQL Server");
        return pool;
    } catch (err) {
        console.error("SQL Connection Error:", err);
    }
}

module.exports = { sql, getPool };