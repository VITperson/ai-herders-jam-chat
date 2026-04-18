-- Prosody config — chat1.local (hackathon demo, plain auth, s2s-ready)

admins = { "admin@chat1.local" }

plugin_paths = { "/usr/lib/prosody/modules", "/opt/prosody-modules" }

modules_enabled = {
    "roster";
    "saslauth";
    "tls";
    "dialback";        -- s2s authentication
    "disco";
    "carbons";
    "pep";
    "private";
    "blocklist";
    "vcard4";
    "vcard_legacy";
    "version";
    "uptime";
    "time";
    "ping";
    "register";
    "admin_adhoc";
    "admin_telnet";
    "posix";
    "bosh";
    "websocket";
    "http";
}

-- Plaintext passwords in Prosody's internal store
-- Phase 3: delegate password checks to the chat-app REST API.
-- Mnesia user store is ignored; prosody has no local passwords.
authentication = "http_bridge"
auth_http_url = "http://web:3000/api/auth/xmpp-check"

-- HTTP bridge only knows the plaintext password → PLAIN only (on the
-- wire it's wrapped in SASL PLAIN; xmpp.js 0.13 also has a SCRAM quirk
-- with prosody 0.11, so keeping these disabled simplifies both phases).
disable_sasl_mechanisms = { "SCRAM-SHA-1", "SCRAM-SHA-1-PLUS", "SCRAM-SHA-256", "DIGEST-MD5" }

-- Demo: allow plain SASL on unencrypted streams; don't require TLS
allow_unencrypted_plain_auth = true
c2s_require_encryption = false
s2s_require_encryption = false
s2s_secure_auth = false

log = {
    { levels = { min = "info" }, to = "console" };
}

pidfile = "/var/run/prosody/prosody.pid"

http_ports = { 5280 }
http_interfaces = { "*", "::" }
https_ports = {}     -- don't try to listen on 5281 (no cert)

storage = "internal"

-- Auto-generated certs land under /etc/prosody/certs on first start;
-- we omit explicit cert paths so prosody falls back gracefully if missing.

VirtualHost "chat1.local"

Component "conference.chat1.local" "muc"
    restrict_room_creation = false
