#!/usr/bin/env node
/**
 * Create (or update) the single shared editor account and grant it the admin role.
 *
 * Usage:
 *   cp .env.example .env.local   # fill in URL + SERVICE_ROLE_KEY + editor password
 *   npm install
 *   npm run setup:editor
 */

import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = (process.env.EDITOR_EMAIL || 'editor@therisingtimes.local').trim().toLowerCase();
const password = process.env.EDITOR_PASSWORD;
const displayName = process.env.EDITOR_DISPLAY_NAME || 'Magazine Editor';

if (!url || !serviceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Copy .env.example to .env.local first.');
  process.exit(1);
}

if (!password || password.length < 10) {
  console.error('Set EDITOR_PASSWORD to a strong password of at least 10 characters.');
  process.exit(1);
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

async function findUserByEmail(target) {
  let page = 1;
  const perPage = 1000;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`could not list users: ${error.message}`);
    const match = (data?.users || []).find((user) => user.email?.toLowerCase() === target);
    if (match) return match;
    if (!data?.users || data.users.length < perPage) return null;
    page += 1;
  }
}

async function main() {
  const existing = await findUserByEmail(email);
  let userId;

  if (existing) {
    const { data, error } = await supabase.auth.admin.updateUserById(existing.id, {
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName }
    });
    if (error) throw new Error(`could not update editor user: ${error.message}`);
    userId = data.user.id;
    console.log(`Updated existing editor account: ${email}`);
  } else {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName }
    });
    if (error) throw new Error(`could not create editor user: ${error.message}`);
    userId = data.user.id;
    console.log(`Created editor account: ${email}`);
  }

  const { error: profileError } = await supabase.from('profiles').upsert(
    {
      id: userId,
      email,
      display_name: displayName,
      role: 'admin'
    },
    { onConflict: 'id' }
  );
  if (profileError) throw new Error(`could not grant admin role: ${profileError.message}`);

  console.log('Editor account is ready. Sign in at /admin.html with the shared email and password.');
}

main().catch((error) => {
  console.error('\nSetup failed:', error.message);
  process.exit(1);
});
