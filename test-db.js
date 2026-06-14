const { getPool } = require("./db");

async function test() {
    const pool = await getPool();

    if (!pool) {
        console.log("No DB connection");
        return;
    }

    const result = await pool.request().query("SELECT 1 AS test");
    console.log(result.recordset);
}

test();