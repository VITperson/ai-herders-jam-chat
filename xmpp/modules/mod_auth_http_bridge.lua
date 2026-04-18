-- mod_auth_http_bridge.lua
--
-- Minimal HTTP-auth bridge for prosody. Delegates password checks to an
-- external HTTP endpoint (our chat-app `/api/auth/xmpp-check`). No user
-- storage lives in prosody — xmpp accounts exist iff they exist in the
-- chat-app `users` table.
--
-- Config:
--   authentication = "http_bridge"
--   auth_http_url  = "http://web:3000/api/auth/xmpp-check"
--
-- The endpoint is POSTed form-encoded (user=<local>&pass=<plain>) and
-- must answer 2xx for success, anything else for failure.

local new_sasl = require "util.sasl".new;
local http = require "net.http";
local http_util = require "util.http";
local async = require "util.async";

local log = module._log;

local auth_url = module:get_option_string("auth_http_url");
if not auth_url then
    log("error", "auth_http_url is not configured; mod_auth_http_bridge will reject everything");
end

-- Blocking POST using prosody's async waiter (runs inside a coroutine).
local function check_password(username, password)
    if not auth_url then return false; end
    local body = http_util.formencode({ user = username, pass = password });

    local wait, done = async.waiter();
    local out_code, out_err;
    http.request(auth_url, {
        method = "POST";
        body = body;
        headers = { ["Content-Type"] = "application/x-www-form-urlencoded" };
    }, function(_body, code)
        out_code = code;
        if type(code) ~= "number" then out_err = tostring(code); end
        done();
    end);
    wait();

    if type(out_code) ~= "number" then
        log("warn", "auth_http_bridge: request to %s failed: %s", auth_url, tostring(out_err));
        return false;
    end
    if out_code >= 200 and out_code < 300 then return true; end
    if out_code == 401 or out_code == 403 then return false; end
    log("warn", "auth_http_bridge: unexpected response %d from %s", out_code, auth_url);
    return false;
end

local provider = {};

function provider.test_password(username, password)
    return check_password(username, password);
end

function provider.user_exists(_username)
    -- Let test_password do the real check.
    return true;
end

function provider.users()
    return function() return nil; end;
end

function provider.set_password(_username, _password)
    return nil, "setting password not supported by http bridge";
end

function provider.create_user(_username, _password)
    return nil, "account creation not supported (register via chat-app)";
end

function provider.delete_user(_username)
    return nil, "account deletion not supported by http bridge";
end

function provider.get_sasl_handler(_session)
    local profile = {
        plain_test = function(_, username, password, _realm)
            return check_password(username, password), true;
        end;
    };
    return new_sasl(module.host, profile);
end

module:provides("auth", provider);
