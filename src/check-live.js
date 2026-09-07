import { env, hasApiCredentials, hasAccessToken } from './config/env.js';
import { KiteConnect as BrokerClient } from 'kiteconnect';

console.log("Subh's stock dashboard — broker diagnostics");
console.log('Environment source:', env.envFiles.source);
console.log('Backend .env:', env.envFiles.backend, env.envFiles.backendExists ? '(found)' : '(missing)');
console.log('Root .env:', env.envFiles.root, env.envFiles.rootExists ? '(found)' : '(missing)');
console.log('API key:', hasApiCredentials() ? 'present' : 'missing');
console.log('API secret:', hasApiCredentials() ? 'present' : 'missing');
console.log('Access token:', hasAccessToken() ? 'present' : 'missing');
console.log('Mode:', env.mode);
console.log('Demo fallback:', env.demoFallback);
console.log('Redirect URL:', env.redirectUrl);

if (!hasApiCredentials()) {
  console.error('\nLive mode cannot start: BROKER_API_KEY and BROKER_API_SECRET are missing.');
  process.exit(2);
}

if (!hasAccessToken()) {
  console.error('\nLive mode cannot start: BROKER_ACCESS_TOKEN is missing.');
  console.error('Use Settings > Connect broker account to obtain a fresh trading-day access token.');
  process.exit(2);
}

try {
  const client = new BrokerClient({ api_key: env.apiKey });
  client.setAccessToken(env.accessToken);
  const profile = await client.getProfile();
  console.log('\nBroker authentication: VALID');
  console.log('User:', profile?.user_id || '—');
  console.log('Broker:', profile?.broker || '—');
} catch (error) {
  console.error('\nBroker authentication: FAILED');
  console.error('Message:', error?.message || error);
  console.error('Status:', error?.status || error?.response?.status || 'unknown');
  console.error('\nMost common cause: the access token is expired/invalid. Broker access tokens are valid for the trading day and a fresh login is required.');
  process.exit(1);
}
