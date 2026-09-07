import * as dns from 'node:dns';

describe('DNS bootstrap', () => {
  it('uses configurable DNS servers for Atlas SRV lookups', async () => {
    jest.resetModules();
    process.env.DNS_SERVERS = '8.8.8.8, 1.1.1.1';
    const { configureDnsServers } = await import('./dns.bootstrap');
    expect(configureDnsServers()).toEqual(['8.8.8.8', '1.1.1.1']);
    expect(dns.getServers()).toEqual(['8.8.8.8', '1.1.1.1']);
    delete process.env.DNS_SERVERS;
  });

  it('rejects an empty DNS configuration', async () => {
    const { configureDnsServers } = await import('./dns.bootstrap');
    expect(() => configureDnsServers(' , ')).toThrow('at least one');
  });
});
