// CI 里等 MySQL 服务容器就绪（最多 90 秒）
const { createConnection } = require('mysql2/promise');

async function main() {
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const conn = await createConnection(process.env.MYSQL_URL);
      await conn.end();
      console.log('MySQL 已就绪');
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
