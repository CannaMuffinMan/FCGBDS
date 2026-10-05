import type { Telemetry } from './telemetry';

export function prometheusText(telemetry: Telemetry, mode: string, store: string): string {
  const snap = telemetry.snapshot();
  const checks = telemetry.checksSnapshot();
  const lines = [
    '# HELP fcgbds_requests_total Evaluated requests by lane and outcome.',
    '# TYPE fcgbds_requests_total counter',
  ];
  for (const lane of ['live', 'practice'] as const) {
    const row = snap[lane];
    lines.push(`fcgbds_requests_total{lane="${lane}",outcome="evaluated"} ${row.evaluated}`);
    lines.push(`fcgbds_requests_total{lane="${lane}",outcome="allowed"} ${row.allowed}`);
    lines.push(`fcgbds_requests_total{lane="${lane}",outcome="observed_would_block"} ${row.observedWouldBlock}`);
    lines.push(`fcgbds_requests_total{lane="${lane}",outcome="observed_would_challenge"} ${row.observedWouldChallenge}`);
    lines.push(`fcgbds_requests_total{lane="${lane}",outcome="enforced_blocked"} ${row.enforcedBlocked}`);
    lines.push(`fcgbds_requests_total{lane="${lane}",outcome="enforced_challenged"} ${row.enforcedChallenged}`);
    lines.push(`fcgbds_requests_total{lane="${lane}",outcome="allowlisted"} ${row.allowlisted}`);
  }
  lines.push('# HELP fcgbds_checks_issued_total Visitor checks issued.');
  lines.push('# TYPE fcgbds_checks_issued_total counter');
  lines.push(`fcgbds_checks_issued_total ${checks.checksIssued}`);
  lines.push('# HELP fcgbds_checks_passed_total Visitor checks passed.');
  lines.push('# TYPE fcgbds_checks_passed_total counter');
  lines.push(`fcgbds_checks_passed_total ${checks.passed}`);
  lines.push('# HELP fcgbds_checks_not_verified Current failed plus outstanding visitor checks.');
  lines.push('# TYPE fcgbds_checks_not_verified gauge');
  lines.push(`fcgbds_checks_not_verified ${checks.notVerified}`);
  lines.push('# HELP fcgbds_stopped_total Requests blocked in enforce mode.');
  lines.push('# TYPE fcgbds_stopped_total counter');
  lines.push(`fcgbds_stopped_total ${checks.stopped}`);
  lines.push('# HELP fcgbds_info Process mode and store backend.');
  lines.push('# TYPE fcgbds_info gauge');
  lines.push(`fcgbds_info{mode="${mode}",store="${store}"} 1`);
  return `${lines.join('\n')}\n`;
}
