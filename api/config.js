// ============================================================
// TENANT CONFIG — API side (CommonJS)
// Single source of truth for all tenant-specific values.
// For a new customer: set environment variables, deploy. Done.
// ============================================================

function env(key, fallback) {
  return process.env[key] || fallback;
}
function envBool(key, fallback) {
  if (process.env[key] !== undefined) return process.env[key] === 'true' || process.env[key] === '1';
  return fallback;
}

const config = {
  // ── TENANT IDENTITY ─────────────────────────────────────────
  tenantId:       env('TENANT_ID',       'serirasa'),
  tenantName:     env('TENANT_NAME',     'Seri Rasa'),
  tenantLegal:    env('TENANT_LEGAL',    'Vertical Target Services Sdn. Bhd.'),
  tenantAlias:    env('TENANT_ALIAS',    'Mazza Spice / Rempah Emas'),
  tenantIndustry: env('TENANT_INDUSTRY', 'Halal OEM spice and condiment manufacturer'),
  tenantLocation: env('TENANT_LOCATION', 'Rawang, Selangor, Malaysia'),

  // ── BRANDING ────────────────────────────────────────────────
  brandName:      env('BRAND_NAME',      'OCC'),
  brandTagline:   env('BRAND_TAGLINE',   'Operations Command Centre'),

  // ── REDIS KEY PREFIX ────────────────────────────────────────
  redisPrefix:    env('REDIS_PREFIX',    'mazza_'),

  // ── FEATURE FLAGS ───────────────────────────────────────────
  enableHalal:       envBool('ENABLE_HALAL',        true),
  enablePOIntake:    envBool('ENABLE_PO_INTAKE',    true),
  enableAIAssistant: envBool('ENABLE_AI_ASSISTANT', true),

  // ── SQL ACCOUNT DEFAULTS ────────────────────────────────────
  // Used when creating new SOs and when creating new customers (PR B).
  // Each tenant should set these in their .env to match their
  // SQL Account chart of accounts and standard terms.
  sqlControlAccount: env('SQL_DEFAULT_CONTROLACCOUNT', '300-0000'),
  sqlCurrency:       env('SQL_DEFAULT_CURRENCY',      'MYR'),
  sqlCreditTerm:     env('SQL_DEFAULT_CREDITTERM',    '30 DAYS'),
  defaultLocation:   env('SQL_DEFAULT_LOCATION',      'SW'),

  // ── HELPERS ─────────────────────────────────────────────────
  redisKey(name) { return `${this.redisPrefix}${name}`; },
  get fullName() { return `${this.tenantName} / ${this.tenantLegal}`; },
  get aiContext() {
    return `${this.tenantName} (also known as ${this.tenantAlias}), a ${this.tenantIndustry} in ${this.tenantLocation}`;
  },
  get sellerNames() {
    const names = [this.tenantName, this.tenantLegal];
    if (this.tenantAlias) names.push(...this.tenantAlias.split('/').map(s => s.trim()));
    return names.filter(Boolean);
  },
};

module.exports = config;
