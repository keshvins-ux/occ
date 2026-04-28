// ============================================================
// TENANT CONFIG — Single source of truth for customer-specific values
//
// Every tenant-specific string in the codebase reads from here.
// For a new customer: set environment variables, deploy. Done.
//
// Usage (API):   const config = require('./config');
// Usage (React): import config from '../config';
// ============================================================

const config = {
  // ── TENANT IDENTITY ─────────────────────────────────────────
  tenantId:       env('TENANT_ID',       'serirasa'),
  tenantName:     env('TENANT_NAME',     'Seri Rasa'),
  tenantLegal:    env('TENANT_LEGAL',    'Vertical Target Services Sdn. Bhd.'),
  tenantAlias:    env('TENANT_ALIAS',    'Mazza Spice / Rempah Emas'),  // alternate names customers may know
  tenantIndustry: env('TENANT_INDUSTRY', 'Halal OEM spice and condiment manufacturer'),
  tenantLocation: env('TENANT_LOCATION', 'Rawang, Selangor, Malaysia'),

  // ── BRANDING ────────────────────────────────────────────────
  brandName:      env('BRAND_NAME',      'OCC'),
  brandTagline:   env('BRAND_TAGLINE',   'Operations Command Centre'),
  brandAccent:    env('BRAND_ACCENT',    '#4F7CF7'),  // primary colour

  // ── REDIS KEY PREFIX ────────────────────────────────────────
  // All Redis keys are prefixed with this value.
  // Seri Rasa = 'mazza_', new customer = 'custb_', etc.
  redisPrefix:    env('REDIS_PREFIX',    'mazza_'),

  // ── FEATURE FLAGS ───────────────────────────────────────────
  enableHalal:       envBool('ENABLE_HALAL',        true),
  enablePOIntake:    envBool('ENABLE_PO_INTAKE',    true),
  enableAIAssistant: envBool('ENABLE_AI_ASSISTANT', true),
  enableProduction:  envBool('ENABLE_PRODUCTION',   false),
  enableProcurement: envBool('ENABLE_PROCUREMENT',  false),

  // ── SQL ACCOUNT DEFAULTS ────────────────────────────────────
  // Mirrored from api/config.js. Frontend uses defaultLocation in
  // PO Intake when creating SOs (replaces hardcoded 'SW').
  // NOTE: env vars here only resolve at build time if prefixed with
  // REACT_APP_. Until env var loading is unified, defaults apply.
  sqlControlAccount: env('SQL_DEFAULT_CONTROLACCOUNT', '300-0000'),
  sqlCurrency:       env('SQL_DEFAULT_CURRENCY',      'MYR'),
  sqlCreditTerm:     env('SQL_DEFAULT_CREDITTERM',    '30 DAYS'),
  defaultLocation:   env('SQL_DEFAULT_LOCATION',      'SW'),

  // ── DERIVED HELPERS ─────────────────────────────────────────
  // Redis key with prefix
  redisKey(name) { return `${this.redisPrefix}${name}`; },

  // Full display name: "Seri Rasa / Vertical Target Services Sdn. Bhd."
  get fullName() { return `${this.tenantName} / ${this.tenantLegal}`; },

  // AI system prompt context
  get aiContext() {
    return `${this.tenantName} (also known as ${this.tenantAlias}), a ${this.tenantIndustry} in ${this.tenantLocation}`;
  },

  // Seller names for PO extraction (these are the SELLER, not the buyer)
  get sellerNames() {
    const names = [this.tenantName, this.tenantLegal];
    if (this.tenantAlias) names.push(...this.tenantAlias.split('/').map(s => s.trim()));
    return names.filter(Boolean);
  },
};

// ── ENV HELPERS ───────────────────────────────────────────────
function env(key, fallback) {
  if (typeof process !== 'undefined' && process.env && process.env[key]) {
    return process.env[key];
  }
  return fallback;
}

function envBool(key, fallback) {
  if (typeof process !== 'undefined' && process.env && process.env[key] !== undefined) {
    return process.env[key] === 'true' || process.env[key] === '1';
  }
  return fallback;
}

// Support both CommonJS (API) and ESM (React)
// In React: import config from '../config';
// In API:   const config = require('../src/config'); or inline
export default config;
