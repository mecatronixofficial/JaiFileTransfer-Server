import * as dns from 'node:dns';

/**
 * Atlas mongodb+srv URIs require DNS SRV and TXT lookups. Some Windows setups
 * expose a local stub resolver (often 127.0.0.1) that refuses those queries.
 * Configure the resolver before Nest/Mongoose starts loading the application.
 */
export function configureDnsServers(
  value = process.env.DNS_SERVERS ?? '8.8.8.8,1.1.1.1',
): string[] {
  const servers = value
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean);

  if (!servers.length) {
    throw new Error('DNS_SERVERS must contain at least one DNS server address');
  }

  dns.setServers(servers);
  return servers;
}

configureDnsServers();
