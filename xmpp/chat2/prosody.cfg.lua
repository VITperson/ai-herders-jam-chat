-- Prosody config — chat2.local (second server for s2s federation demo)

admins = { "admin@chat2.local" }

plugin_paths = { "/usr/lib/prosody/modules", "/opt/prosody-modules" }

modules_enabled = {
    "roster";
    "saslauth";
    "tls";
    "dialback";
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

-- Phase 3: delegate password checks to the chat-app REST API.
authentication = "http_bridge"
auth_http_url = "http://web:3000/api/auth/xmpp-check"

disable_sasl_mechanisms = { "SCRAM-SHA-1", "SCRAM-SHA-1-PLUS", "SCRAM-SHA-256", "DIGEST-MD5" }

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
https_ports = {}

storage = "internal"

VirtualHost "chat2.local"

Component "conference.chat2.local" "muc"
    restrict_room_creation = false
