'use strict';

const https = require('https');
const { execSync } = require('child_process');

// Load Cliq config from Secrets Manager at startup
let cliqConfig = null;

async function getCliqConfig() {
  if (cliqConfig) return cliqConfig;
  try {
    const result = execSync(
      'aws secretsmanager get-secret-value --region us-east-2 --secret-id coreidentity/coreg/cliq --query SecretString --output text',
      { encoding: 'utf8', timeout: 5000 }
    );
    cliqConfig = JSON.parse(result.trim());
    return cliqConfig;
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', message: 'Failed to load Cliq config', error: err.message
    }));
    return null;
  }
}

async function sendCliqMessage(channelUrl, message) {
  const config = await getCliqConfig();
  if (!config?.token || !channelUrl) {
    console.warn(JSON.stringify({
      level: 'warn', message: 'Cliq not configured — skipping notification'
    }));
    return false;
  }

  return new Promise((resolve) => {
    const payload = JSON.stringify({ text: message });
    const urlObj  = new URL(channelUrl);

    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname,
      method:   'POST',
      headers: {
        'Authorization': `Zoho-oauthtoken ${config.token}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log(JSON.stringify({
            level: 'info', message: 'Cliq notification sent',
            channel: channelUrl.split('/').pop(),
            timestamp: new Date().toISOString()
          }));
          resolve(true);
        } else {
          console.warn(JSON.stringify({
            level: 'warn', message: 'Cliq notification failed',
            status: res.statusCode, response: data
          }));
          resolve(false);
        }
      });
    });

    req.on('error', (err) => {
      console.error(JSON.stringify({
        level: 'error', message: 'Cliq request error', error: err.message
      }));
      resolve(false);
    });

    req.write(payload);
    req.end();
  });
}

const STAGE_EMOJIS = {
  intake:'📥', kyc_verification:'🔍', appraisal_review:'📋',
  bank_assignment:'🏦', collateralization:'🔒', monetization:'💰',
  securitization:'📄', tokenization:'🪙', completed:'✅',
  rejected:'❌', on_hold:'⏸️'
};

async function notifyPipelineAdvance(data) {
  const { pipeline_reference, asset_type, client_name,
          from_stage, to_stage, transitioned_by } = data;
  const config = await getCliqConfig();
  if (!config) return;

  const emoji = STAGE_EMOJIS[to_stage] || '➡️';
  const msg = [
    `${emoji} *Pipeline Advanced*`,
    `Reference: ${pipeline_reference}`,
    `Asset: ${asset_type?.replace(/_/g,' ')}`,
    `Client: ${client_name || 'Unknown'}`,
    `Stage: ${from_stage?.replace(/_/g,' ')} → *${to_stage?.replace(/_/g,' ')}*`,
    `By: ${transitioned_by}`,
    `Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`
  ].join('\n');

  return sendCliqMessage(config.pipeline_alerts_url, msg);
}

async function notifyAlert(data) {
  const { severity, message, pipeline_reference } = data;
  const config = await getCliqConfig();
  if (!config) return;

  const emoji = severity === 'critical' ? '🚨' : severity === 'warning' ? '⚠️' : 'ℹ️';
  const msg = [
    `${emoji} *${severity?.toUpperCase()} Alert*`,
    message,
    pipeline_reference ? `Reference: ${pipeline_reference}` : '',
    `Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`
  ].filter(Boolean).join('\n');

  return sendCliqMessage(config.compliance_url, msg);
}

async function notifyAgentAction(data) {
  const { agent_name, action, status, message } = data;
  if (status === 'error' || action?.includes('REJECT') || action?.includes('HOLD') || action?.includes('BLOCK')) {
    const config = await getCliqConfig();
    if (!config) return;

    const msg = [
      `🤖 *Agent Action Required*`,
      `Agent: ${agent_name}`,
      `Status: ${status}`,
      `Action: ${action}`,
      message,
      `Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`
    ].filter(Boolean).join('\n');

    return sendCliqMessage(config.agent_actions_url, msg);
  }
  return true;
}

async function notifyMonitoringResults(results) {
  const contract    = results.contract_monitoring;
  const transaction = results.transaction_monitoring;
  const critical = (contract?.critical || 0) + (transaction?.critical || 0);
  const warning  = (contract?.warning  || 0) + (transaction?.warning  || 0);
  if (critical === 0 && warning === 0) return true;

  const config = await getCliqConfig();
  if (!config) return;

  const msg = [
    `📊 *Monitoring Cycle Complete*`,
    critical > 0 ? `🚨 ${critical} critical alert(s)` : '',
    warning  > 0 ? `⚠️  ${warning} warning(s)` : '',
    `Contract alerts: ${contract?.alerts_generated || 0}`,
    `Transaction anomalies: ${transaction?.anomalies_found || 0}`,
    `Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`
  ].filter(Boolean).join('\n');

  return sendCliqMessage(config.compliance_url, msg);
}

module.exports = {
  sendCliqMessage,
  notifyPipelineAdvance,
  notifyAlert,
  notifyAgentAction,
  notifyMonitoringResults
};
