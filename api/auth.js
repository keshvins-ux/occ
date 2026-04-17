import { createClient } from 'redis';

// Default users — passwords stored in Redis so they can be changed
const DEFAULT_USERS = [
  { id: "keshvin",  name: "Keshvin",  email: "keshvin.s@mazzaspice.com",  password: "Mazza@Kesh2026!",  role: "admin",      sales: true,  ops: true,  procurement: true  },
  { id: "jasmine",  name: "Jasmine",  email: "jasmine@mazzaspice.com",    password: "Mazza@Jazz2026!",  role: "sales",      sales: true,  ops: false, procurement: false },
  { id: "varinder", name: "Varinder", email: "varinder@mazzaspice.com",   password: "Mazza@Vari2026!",  role: "admin",      sales: true,  ops: true,  procurement: true  },
  { id: "narin",    name: "Narin",    email: "narin@mazzaspice.com",      password: "Mazza@Nari2026!",  role: "sales",      sales: true,  ops: true,  procurement: false },
  { id: "vitya",    name: "Vitya",    email: "salesadmin@mazzaspice.com", password: "Mazza@Vity2026!",  role: "ops",        sales: false, ops: true,  procurement: false },
  { id: "navin",    name: "Navin",    email: "nav@mazzaspice.com",        password: "Mazza@Navi2026!",  role: "sales",      sales: true,  ops: true,  procurement: true  },
  { id: "yuges",    name: "Yuges",    email: "yuges@mazzaspice.com",      password: "Mazza@Yuge2026!",  role: "production", sales: false, ops: true,  procurement: true  },
  { id: "mhae",     name: "Mhae",     email: "mhae@mazzaspice.com",       password: "Mazza@Mhae2026!",  role: "sales",      sales: true,  ops: false, procurement: false },
  { id: "amirun",   name: "Amirun",   email: "amirun@mazzaspice.com",     password: "Mazza@Amir2026!",  role: "ops",        sales: false, ops: true,  procurement: false },
];

const REDIS_KEY = 'mazza_users';

async function getClient() {
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();
  return client;
}

async function getUsers(client) {
  const raw = await client.get(REDIS_KEY);
  if (raw) return JSON.parse(raw);
  // First run — seed defaults
  await client.set(REDIS_KEY, JSON.stringify(DEFAULT_USERS));
  return DEFAULT_USERS;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const client = await getClient();

  try {
    const { action } = req.body || req.query;

    // -- LOGIN --------------------------------------------------------------
    if (action === 'login') {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Missing email or password' });
      const users = await getUsers(client);
      const user = users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.password === password);
      if (!user) return res.status(401).json({ error: 'Incorrect email or password' });
      const { password: _, ...safeUser } = user;
      return res.status(200).json({ user: safeUser });
    }

    // -- GET USERS (admin only, no passwords) ------------------------------
    if (action === 'list' && req.method === 'GET') {
      const users = await getUsers(client);
      return res.status(200).json({ users: users.map(({ password: _, ...u }) => u) });
    }

    // -- CHANGE PASSWORD ---------------------------------------------------
    if (action === 'change_password') {
      const { email, oldPassword, newPassword } = req.body;
      if (!email || !oldPassword || !newPassword) return res.status(400).json({ error: 'Missing fields' });
      // Validate password strength
      const strong = /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[@$!%*?&!#^])[A-Za-z\d@$!%*?&!#^]{8,}$/;
      if (!strong.test(newPassword)) {
        return res.status(400).json({ error: 'Password must be 8+ chars with uppercase, lowercase, number and symbol' });
      }
      const users = await getUsers(client);
      const idx = users.findIndex(u => u.email.toLowerCase() === email.toLowerCase() && u.password === oldPassword);
      if (idx === -1) return res.status(401).json({ error: 'Current password incorrect' });
      users[idx].password = newPassword;
      // Store reset history (admin can retrieve)
      const histKey = `mazza_pw_history:${users[idx].id}`;
      const hist = JSON.parse(await client.get(histKey) || '[]');
      hist.unshift({ password: newPassword, changedAt: new Date().toISOString() });
      await client.set(histKey, JSON.stringify(hist.slice(0, 10)));
      await client.set(REDIS_KEY, JSON.stringify(users));
      return res.status(200).json({ success: true });
    }

    // -- ADMIN RESET (retrieves stored passwords) --------------------------
    if (action === 'admin_reset') {
      const { adminKey, userId, newPassword } = req.body;
      if (adminKey !== process.env.ADMIN_SECRET_KEY) return res.status(403).json({ error: 'Forbidden' });
      const users = await getUsers(client);
      const idx = users.findIndex(u => u.id === userId);
      if (idx === -1) return res.status(404).json({ error: 'User not found' });
      if (newPassword) {
        users[idx].password = newPassword;
        await client.set(REDIS_KEY, JSON.stringify(users));
        return res.status(200).json({ success: true, message: `Password reset for ${users[idx].name}` });
      }
      // Return current password for this user
      return res.status(200).json({ userId, name: users[idx].name, password: users[idx].password });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: err.message });
  } finally {
    await client.disconnect();
  }
}
