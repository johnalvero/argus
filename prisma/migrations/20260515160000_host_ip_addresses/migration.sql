-- Capture the host's private IPv4 address(es) reported by the
-- inventory agent. `privateIp` is the primary (first global-scope IPv4)
-- for display + search. `ipAddresses` is the full JSON-encoded array
-- of {iface, addr} objects so multi-NIC hosts don't lose secondary
-- interfaces.
ALTER TABLE "Host" ADD COLUMN "privateIp" TEXT;
ALTER TABLE "Host" ADD COLUMN "ipAddresses" TEXT;
