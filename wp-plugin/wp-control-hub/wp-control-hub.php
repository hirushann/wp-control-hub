<?php
/**
 * Plugin Name: WP Control Hub Connector
 * Description: Links this site to WP Control Hub: malware scans, admin account checks, Google Drive backups, updates with automatic rollback, remote restore.
 * Version: 0.5.3
 * Requires PHP: 7.4
 */

defined('ABSPATH') || exit;

define('WPCH_OPT', 'wpch_connection');
define('WPCH_DIR', WP_CONTENT_DIR . '/wpch-backups');
// not worth backing up: our temp files, caches, WP upgrade temp dirs, other backup plugins' archives
define('WPCH_SKIP', '#^' . preg_quote(WP_CONTENT_DIR, '#') . '/(wpch-backups|cache|upgrade|upgrade-temp-backup|wpvividbackups|updraft|ai1wm-backups|backups-dup-lite|backups-dup-pro|backup-db|uploads/backup-guard)/#');

const WPCH_SIGNATURES = [
	'eval() of encoded payload'       => '/\beval\s*\(\s*(?:base64_decode|gzinflate|gzuncompress|gzdecode|str_rot13|strrev)\s*\(/i',
	'eval/assert of request input'    => '/\b(?:eval|assert)\s*\(\s*(?:stripslashes\s*\(\s*)?\$_(?:POST|GET|REQUEST|COOKIE|SERVER)\b/i',
	'request input called as function' => '/\$_(?:POST|GET|REQUEST|COOKIE)\s*\[[^\]]+\]\s*\(/',
	'shell command from request input' => '/\b(?:system|exec|shell_exec|passthru|popen|proc_open)\s*\(\s*\$_(?:POST|GET|REQUEST|COOKIE)\b/i',
	'base64-decoded request input'    => '/base64_decode\s*\(\s*\$_(?:POST|GET|REQUEST|COOKIE)\b/i',
];

function wpch_conn() {
	$c = get_option(WPCH_OPT);
	return is_array($c) ? $c : null;
}

// Must match sign() in the hub's lib/hub.ts
function wpch_sign($secret, $ts, $body) {
	return hash_hmac('sha256', $ts . '.' . $body, $secret);
}

/* ---------- Settings page: paste the connection key from the hub ---------- */

add_action('admin_menu', function () {
	add_options_page('Control Hub', 'Control Hub', 'manage_options', 'wpch', 'wpch_settings_page');
});

function wpch_settings_page() {
	if (isset($_POST['wpch_key']) && check_admin_referer('wpch_save') && current_user_can('manage_options')) {
		$c = json_decode(base64_decode(trim(wp_unslash($_POST['wpch_key']))), true);
		if (is_array($c) && !empty($c['id']) && !empty($c['secret']) && !empty($c['hub']) && wp_http_validate_url($c['hub'])) {
			update_option(WPCH_OPT, ['hub' => esc_url_raw($c['hub']), 'id' => sanitize_text_field($c['id']), 'secret' => sanitize_text_field($c['secret'])], false);
			echo '<div class="notice notice-success"><p>Connected.</p></div>';
		} else {
			echo '<div class="notice notice-error"><p>Invalid connection key.</p></div>';
		}
	}
	$c = wpch_conn();
	?>
	<div class="wrap">
		<h1>Control Hub</h1>
		<p>Status: <?php echo $c ? 'Connected to ' . esc_html($c['hub']) : 'Not connected'; ?></p>
		<p>Login URL: <?php echo wpch_login_slug_on() ? '<a href="' . esc_url(wpch_login_url()) . '"><code>' . esc_html(wpch_login_url()) . '</code></a> (bookmark it: /wp-login.php and /wp-admin now return 404 when logged out)' : 'default (/wp-login.php)'; ?></p>
		<form method="post">
			<?php wp_nonce_field('wpch_save'); ?>
			<p><label for="wpch_key">Connection key (from the hub's site page)</label><br>
				<textarea id="wpch_key" name="wpch_key" rows="4" cols="80" required></textarea></p>
			<?php submit_button('Save'); ?>
		</form>
	</div>
	<?php
}

/* ---------- Custom login URL: /ynlog instead of /wp-login.php and /wp-admin ----------
   wp-admin itself can't be renamed (core hardcodes it). Instead: login lives at /ynlog, and
   /wp-login.php plus /wp-admin for logged-out visitors return 404. Logged-in users still use /wp-admin.
   Escape hatch if locked out: define('WPCH_DISABLE_LOGIN_SLUG', true); in wp-config.php (or remove the plugin folder). */

const WPCH_LOGIN_SLUG = 'ynlog';

function wpch_login_slug_on() {
	return !defined('WPCH_DISABLE_LOGIN_SLUG') && !(defined('WP_CLI') && WP_CLI) && !is_multisite(); // shortcut: single-site only
}

function wpch_login_url() {
	return home_url(WPCH_LOGIN_SLUG);
}

// Request path relative to the WordPress home path, e.g. "ynlog" or "wp-login.php"
function wpch_request_path() {
	$path = trim((string) parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH), '/');
	$home = trim((string) parse_url(home_url(), PHP_URL_PATH), '/');
	return $home !== '' && strpos($path, $home) === 0 ? trim(substr($path, strlen($home)), '/') : $path;
}

function wpch_not_found() {
	wp_die('Not found.', 'Not found', ['response' => 404]);
}

// Rewrite every generated wp-login.php link (login, logout, lost password, reset emails, post password form)
function wpch_filter_login_link($url) {
	if (strpos((string) $url, 'wp-login.php') === false) return $url;
	$query = parse_url($url, PHP_URL_QUERY);
	return wpch_login_url() . ($query ? "?$query" : '');
}

/* ---------- Maintenance mode: visitors get a 503 page, logged-in admins see the site ---------- */

add_action('template_redirect', function () {
	if (!get_option('wpch_maintenance') || current_user_can('manage_options')) return;
	header('Retry-After: 3600');
	wp_die(
		'<h1>' . esc_html(get_bloginfo('name')) . '</h1><p>We’re doing some scheduled maintenance. Please check back soon.</p>',
		esc_html(get_bloginfo('name')) . ' · Maintenance',
		['response' => 503]
	);
});

if (wpch_login_slug_on()) {
	foreach (['site_url', 'network_site_url', 'wp_redirect'] as $hook) add_filter($hook, 'wpch_filter_login_link', 100);

	add_action('plugins_loaded', function () {
		$path = wpch_request_path();
		if ($path === 'wp-login.php') wpch_not_found();
		if ($path !== WPCH_LOGIN_SLUG) return;
		// Serve the real login screen at /ynlog once WordPress is fully loaded
		add_action('wp_loaded', function () {
			global $pagenow, $error, $interim_login, $action, $user_login; // wp-login.php expects these as globals
			$pagenow = 'wp-login.php';
			require_once ABSPATH . 'wp-login.php';
			exit;
		});
	}, 1);

	// Logged-out visits to /wp-admin would normally redirect to the login page and reveal it
	add_action('wp_loaded', function () {
		global $pagenow;
		if (is_admin() && !is_user_logged_in() && !wp_doing_ajax() && $pagenow !== 'admin-post.php') wpch_not_found();
	});
}

/* ---------- Hub → site: signed command, queued as a background job ---------- */

add_action('rest_api_init', function () {
	register_rest_route('wpch/v1', '/command', [
		'methods'             => 'POST',
		'permission_callback' => 'wpch_verify_request',
		'callback'            => 'wpch_command',
	]);
});

function wpch_verify_request(WP_REST_Request $r) {
	$c   = wpch_conn();
	$ts  = (string) $r->get_header('x-wpch-ts');
	$sig = (string) $r->get_header('x-wpch-sig');
	// specific reasons so the hub's Activity shows what to fix; none of them leak the secret
	$deny = fn($msg) => new WP_Error('wpch_denied', $msg, ['status' => 401]);
	if (!$c) return $deny('Plugin not connected: paste the connection key in Settings → Control Hub.');
	if ($sig === '' || !ctype_digit($ts)) return $deny('Signature headers missing: a proxy/firewall/security plugin is stripping X-WPCH-* headers.');
	if (abs(time() - (int) $ts) > 300) return $deny('Clock skew: site time is ' . gmdate('c') . ', hub sent ' . gmdate('c', (int) $ts) . '.');
	if (!hash_equals(wpch_sign($c['secret'], $ts, $r->get_body()), $sig)) return $deny('Bad signature: the connection key on this site belongs to a different hub entry. Re-paste the key from this site\'s hub page.');
	return true;
}

function wpch_command(WP_REST_Request $r) {
	$p   = json_decode($r->get_body(), true);
	$cmd = $p['cmd'] ?? '';
	if (!in_array($cmd, ['status', 'scan', 'backup', 'restore', 'connector', 'user', 'settings'], true)) {
		return new WP_Error('wpch_cmd', 'Unknown command', ['status' => 400]);
	}
	// uniqid: WP drops identical single events queued within 10 minutes
	wp_schedule_single_event(time(), 'wpch_job', [$cmd, (array) ($p['args'] ?? []), uniqid()]);
	spawn_cron();
	return new WP_REST_Response(['queued' => $cmd], 202);
}

/* ---------- Site → hub: signed report ---------- */

function wpch_report($type, $ok, $data) {
	$c = wpch_conn();
	if (!$c) return;
	$body = wp_json_encode(['type' => $type, 'ok' => $ok, 'data' => $data]);
	$ts   = (string) time();
	wp_remote_post(rtrim($c['hub'], '/') . '/api/report', [
		'timeout' => 30,
		'headers' => ['content-type' => 'application/json', 'x-wpch-site' => $c['id'], 'x-wpch-ts' => $ts, 'x-wpch-sig' => wpch_sign($c['secret'], $ts, $body)],
		'body'    => $body,
	]);
}

add_action('wpch_job', 'wpch_run_job', 10, 2);

function wpch_run_job($cmd, $args) {
	ignore_user_abort(true);
	@set_time_limit(0);
	wp_raise_memory_limit('admin');
	// one heavy job at a time: a second backup during an update would zip a half-updated site
	$heavy = in_array($cmd, ['backup', 'restore'], true);
	if ($heavy) {
		$since = (int) get_option('wpch_lock');
		if ($since && time() - $since < 2 * HOUR_IN_SECONDS) {
			wpch_report($cmd, false, ['error' => 'Skipped: another backup, update or restore is still running on this site.']);
			return;
		}
		update_option('wpch_lock', time(), false);
	}
	try {
		switch ($cmd) {
			case 'status':  wpch_report('status', true, wpch_status()); break;
			case 'scan':    wpch_report('scan', true, wpch_scan()); break;
			case 'backup':  wpch_backup($args); break;
			case 'restore': wpch_restore($args); break;
			case 'connector': wpch_self_update(); break;
			case 'user':    wpch_user($args); break;
			case 'settings': wpch_settings($args); break;
		}
	} catch (Throwable $e) {
		wpch_report($cmd, false, ['error' => $e->getMessage()]);
	} finally {
		if ($heavy) delete_option('wpch_lock');
	}
}

/* ---------- Status: admin accounts + pending updates ---------- */

function wpch_admin_includes() {
	foreach (['update', 'plugin', 'theme', 'file', 'misc', 'user', 'class-wp-upgrader'] as $f) {
		require_once ABSPATH . "wp-admin/includes/$f.php";
	}
}

// premium = the update isn't served by wordpress.org (licensed vendor). These install only when someone ticks them in the hub.
function wpch_premium($u) {
	$u = (array) $u;
	return strpos((string) ($u['id'] ?? ''), 'w.org/') !== 0 && strpos((string) ($u['url'] ?? ''), '//wordpress.org/') === false;
}

function wpch_status() {
	wpch_admin_includes();
	wp_clean_update_cache(); // force fresh checks instead of the 12h cached ones
	wp_version_check();
	wp_update_plugins();
	wp_update_themes();

	$updates = [];
	// id = what the hub sends back in args.only to pick items
	foreach (get_plugin_updates() as $file => $p) {
		$updates[] = ['id' => $file, 'type' => 'plugin', 'name' => $p->Name, 'from' => $p->Version, 'to' => $p->update->new_version, 'premium' => wpch_premium($p->update)];
	}
	foreach (get_theme_updates() as $slug => $t) {
		$updates[] = ['id' => $slug, 'type' => 'theme', 'name' => $t->get('Name'), 'from' => $t->get('Version'), 'to' => $t->update['new_version'], 'premium' => wpch_premium($t->update)];
	}
	$core = get_core_updates();
	if ($core && $core[0]->response === 'upgrade') {
		$updates[] = ['id' => 'core', 'type' => 'core', 'name' => 'WordPress', 'from' => get_bloginfo('version'), 'to' => $core[0]->current];
	}

	$admins = array_map(function ($u) {
		return ['login' => $u->user_login, 'email' => $u->user_email];
	}, get_users(['role' => 'administrator']));

	// shortcut: staff only (no subscribers/customers), first 200; add paging/search if a site needs to manage customers
	$users = array_map(function ($u) {
		return ['login' => $u->user_login, 'email' => $u->user_email, 'role' => implode(', ', $u->roles)];
	}, get_users(['number' => 200, 'orderby' => 'login', 'role__not_in' => ['subscriber', 'customer']]));

	global $wpdb;
	$theme = wp_get_theme();
	$disk  = function_exists('disk_free_space') ? @disk_free_space(ABSPATH) : false;
	$info  = [
		'name'           => get_bloginfo('name'),
		'theme'          => trim($theme->get('Name') . ' ' . $theme->get('Version')),
		'plugins_active' => count((array) get_option('active_plugins', [])),
		'plugins_total'  => count(get_plugins()),
		'users'          => (int) count_users()['total_users'],
		'db_size'        => (int) $wpdb->get_var($wpdb->prepare('SELECT SUM(data_length + index_length) FROM information_schema.TABLES WHERE table_schema = %s', DB_NAME)),
		'disk_free'      => $disk === false ? null : (int) $disk,
		'https'          => strpos(home_url(), 'https://') === 0,
		'indexing'       => (bool) get_option('blog_public'),
		'debug'          => defined('WP_DEBUG') && WP_DEBUG,
		'debug_log'      => defined('WP_DEBUG_LOG') && WP_DEBUG_LOG,
		'maintenance'    => (bool) get_option('wpch_maintenance'),
		'memory_limit'   => ini_get('memory_limit'),
		'server'         => $_SERVER['SERVER_SOFTWARE'] ?? '',
	];
	// read from disk, not a constant: right after a self-update the old code is still in memory
	$connector = get_file_data(__FILE__, ['v' => 'Version'])['v'];

	return ['wp' => get_bloginfo('version'), 'php' => PHP_VERSION, 'connector' => $connector, 'info' => $info, 'admins' => $admins, 'users' => $users, 'updates' => $updates, 'login_url' => wp_login_url()];
}

/* ---------- Malware scan ---------- */

function wpch_files($dir) {
	if (!is_dir($dir)) return;
	// CATCH_GET_CHILD: skip folders that vanish mid-walk (WP deletes upgrade temp dirs during updates)
	$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::LEAVES_ONLY, RecursiveIteratorIterator::CATCH_GET_CHILD);
	foreach ($it as $f) {
		if ($f->isFile()) yield $f->getPathname();
	}
}

// shortcut: core checksums + uploads PHP + a few signatures. Not a full AV; add plugin checksums (downloads.wordpress.org/plugin-checksums) if needed.
function wpch_scan() {
	wpch_admin_includes();
	$findings = [];
	$add = function ($path, $reason) use (&$findings) {
		$findings[] = ['file' => str_replace(ABSPATH, '', $path), 'reason' => $reason];
	};

	$version = get_bloginfo('version');
	$sums    = get_core_checksums($version, get_locale()) ?: get_core_checksums($version, 'en_US');
	if (!$sums) {
		$add('(core)', 'Could not fetch core checksums from wordpress.org');
	} else {
		foreach ($sums as $file => $md5) {
			if (strpos($file, 'wp-content/') === 0) continue; // bundled themes/plugins may be removed legitimately
			if (!file_exists(ABSPATH . $file)) $add($file, 'Core file missing');
			elseif (md5_file(ABSPATH . $file) !== $md5) $add($file, 'Core file modified');
		}
		foreach (['wp-admin', 'wp-includes'] as $dir) {
			foreach (wpch_files(ABSPATH . $dir) as $path) {
				if (!isset($sums[substr($path, strlen(ABSPATH))])) $add($path, 'Unknown file in core directory');
			}
		}
		foreach (glob(ABSPATH . '*.php') as $path) {
			if (!isset($sums[basename($path)]) && basename($path) !== 'wp-config.php') $add($path, 'Unknown PHP file in site root');
		}
	}

	$uploads = wp_upload_dir()['basedir'];
	foreach (wpch_files($uploads) as $path) {
		if (preg_match('/\.(php\d?|phtml|phar)$/i', $path)) $add($path, 'PHP file in uploads');
	}

	foreach (wpch_files(WP_CONTENT_DIR) as $path) {
		if (!preg_match('/\.(php\d?|phtml|inc)$/i', $path) || strpos($path, WPCH_DIR) === 0 || filesize($path) > 2 * MB_IN_BYTES) continue;
		$src = file_get_contents($path);
		foreach (WPCH_SIGNATURES as $reason => $re) {
			if (preg_match($re, $src)) {
				$add($path, "Suspicious code: $reason");
				break;
			}
		}
	}
	return ['findings' => $findings];
}

/* ---------- Backup / update / restore ---------- */

function wpch_tmp($ext) {
	wp_mkdir_p(WPCH_DIR);
	if (!file_exists(WPCH_DIR . '/.htaccess')) {
		file_put_contents(WPCH_DIR . '/.htaccess', "Require all denied\nDeny from all\n");
		file_put_contents(WPCH_DIR . '/index.php', '<?php // Silence');
	}
	return WPCH_DIR . '/' . wp_generate_password(24, false) . ".$ext"; // unguessable name, deleted after use
}

// One statement per line (values escaped, CREATE flattened) so import can stream line by line.
function wpch_dump_db($file) {
	global $wpdb;
	$dbh = $wpdb->dbh;
	$out = fopen($file, 'wb');
	fwrite($out, "SET NAMES " . ($wpdb->charset ?: "utf8mb4") . ";\nSET FOREIGN_KEY_CHECKS=0;\n");
	$tables = $wpdb->get_col($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($wpdb->base_prefix) . '%'));
	foreach ($tables as $t) {
		$create = $wpdb->get_row("SHOW CREATE TABLE `$t`", ARRAY_N)[1];
		fwrite($out, "DROP TABLE IF EXISTS `$t`;\n" . str_replace(["\r", "\n"], ' ', $create) . ";\n");
		$res = mysqli_query($dbh, "SELECT * FROM `$t`", MYSQLI_USE_RESULT);
		if (!$res) throw new Exception("Dump of $t failed: " . mysqli_error($dbh));
		while ($row = mysqli_fetch_row($res)) {
			$vals = array_map(function ($v) use ($dbh) {
				return $v === null ? 'NULL' : "'" . mysqli_real_escape_string($dbh, $v) . "'";
			}, $row);
			fwrite($out, "INSERT INTO `$t` VALUES (" . implode(',', $vals) . ");\n");
		}
		mysqli_free_result($res);
	}
	fclose($out);
}

function wpch_import_db($file) {
	global $wpdb;
	$in = fopen($file, 'rb');
	while (($line = fgets($in)) !== false) {
		$line = rtrim($line, "\r\n");
		if ($line !== '' && !mysqli_query($wpdb->dbh, $line)) {
			$err = mysqli_error($wpdb->dbh);
			fclose($in);
			throw new Exception("SQL import failed: $err");
		}
	}
	fclose($in);
	wp_cache_flush();
}

// shortcut: assumes wp-content lives inside ABSPATH and the site fits in one S3 PUT (5 GB); use multipart upload beyond that
// $scope: 'both' | 'db' | 'files'
function wpch_make_backup($scope = 'both') {
	$zipfile = wpch_tmp('zip');
	$zip = new ZipArchive();
	if ($zip->open($zipfile, ZipArchive::CREATE) !== true) throw new Exception('Cannot create zip');
	$sql = null;
	if ($scope !== 'files') {
		$sql = wpch_tmp('sql');
		wpch_dump_db($sql);
		$zip->addFile($sql, 'wpch-db.sql');
	}
	if ($scope !== 'db') {
		foreach (wpch_files(ABSPATH) as $path) {
			if (preg_match(WPCH_SKIP, $path)) continue;
			$zip->addFile($path, substr($path, strlen(ABSPATH)));
		}
	}
	$ok = $zip->close();
	if ($sql) unlink($sql);
	if (!$ok) throw new Exception('Writing backup zip failed');
	return $zipfile;
}

function wpch_upload($file, $url) {
	$fh = fopen($file, 'rb');
	$ch = curl_init($url);
	curl_setopt_array($ch, [
		CURLOPT_UPLOAD         => true, // PUT
		CURLOPT_INFILE         => $fh,
		CURLOPT_INFILESIZE     => filesize($file),
		CURLOPT_RETURNTRANSFER => true,
		CURLOPT_HTTPHEADER     => ['Content-Type: application/zip'],
	]);
	$res  = curl_exec($ch);
	$code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
	$err  = curl_error($ch);
	curl_close($ch);
	fclose($fh);
	if ($code !== 200 && $code !== 201) throw new Exception("Upload to Google Drive failed (HTTP $code): " . ($err ?: substr((string) $res, 0, 300)));
	$id = json_decode((string) $res, true)['id'] ?? '';
	if (!$id) throw new Exception('Upload to Google Drive returned no file id');
	return $id;
}

function wpch_restore_db($zipfile) {
	$sql    = wpch_tmp('sql');
	$safety = wpch_tmp('sql');
	try {
		if (!copy("zip://$zipfile#wpch-db.sql", $sql)) throw new Exception('Cannot read database dump from backup');
		wpch_dump_db($safety);
		try {
			wpch_import_db($sql);
		} catch (Throwable $e) {
			wpch_import_db($safety);
			throw $e;
		}
	} finally {
		@unlink($sql);
		@unlink($safety);
	}
}

function wpch_restore_zip($zipfile) {
	$zip = new ZipArchive();
	if ($zip->open($zipfile) !== true) throw new Exception('Cannot open backup zip');

	// Database first (files-only backups have none), with a safety dump so a failed import doesn't leave a half-restored DB
	if ($zip->locateName('wpch-db.sql') !== false) wpch_restore_db($zipfile);

	$names = [];
	for ($i = 0; $i < $zip->numFiles; $i++) {
		$n = $zip->getNameIndex($i);
		if ($n !== 'wpch-db.sql' && strpos($n, '..') === false) $names[] = $n;
	}
	// shortcut: overwrites files but doesn't delete ones added after the backup (e.g. new plugin files)
	if ($names && !$zip->extractTo(ABSPATH, $names)) throw new Exception('Extracting files failed'); // db-only backup: nothing to extract
	$zip->close();
	if (function_exists('opcache_reset')) opcache_reset();
}

function wpch_health_problem() {
	foreach ([home_url('/'), wp_login_url()] as $url) {
		$r = wp_remote_get(add_query_arg('wpch_health', time(), $url), ['timeout' => 30, 'sslverify' => false]);
		if (is_wp_error($r)) return "$url unreachable: " . $r->get_error_message();
		$code = wp_remote_retrieve_response_code($r);
		if ($code >= 500) return "$url returned HTTP $code";
		if (stripos(wp_remote_retrieve_body($r), 'critical error') !== false) return "$url shows a critical error";
	}
	return null;
}

// $only: update ids to install (null = everything pending)
function wpch_update($zipfile, $only = null) {
	$pick    = function ($ids) use ($only) { return $only === null ? $ids : array_values(array_intersect($ids, $only)); };
	$skin    = new Automatic_Upgrader_Skin();
	$updated = [];
	$failed  = [];
	$errors  = []; // id => why it failed
	$collect = function ($results) use (&$updated, &$failed, &$errors, $skin) {
		foreach ((array) $results as $item => $r) {
			if ($r && !is_wp_error($r)) { $updated[] = $item; continue; }
			$failed[] = $item;
			$errors[$item] = is_wp_error($r) ? wpch_update_error($r) : (wpch_last_error($skin) ?: 'WordPress gave no reason');
		}
	};
	if ($plugins = $pick(array_keys(get_plugin_updates()))) $collect((new Plugin_Upgrader($skin))->bulk_upgrade($plugins));
	if ($themes = $pick(array_keys(get_theme_updates()))) $collect((new Theme_Upgrader($skin))->bulk_upgrade($themes));
	$core = get_core_updates();
	if ($core && $core[0]->response === 'upgrade' && $pick(['core'])) $collect(['core' => (new Core_Upgrader($skin))->upgrade($core[0])]);

	if ($problem = wpch_health_problem()) {
		wpch_restore_zip($zipfile);
		return ['updated' => $updated, 'failed' => $failed, 'errors' => $errors, 'rolled_back' => true, 'reason' => $problem];
	}
	return ['updated' => $updated, 'failed' => $failed, 'errors' => $errors, 'rolled_back' => false];
}

function wpch_update_error(WP_Error $e) {
	// premium plugins/themes only hand WordPress a download link while their license is active
	if ($e->get_error_code() === 'no_package') return 'No download available: activate its license on the site, or update it from the vendor.';
	return wp_strip_all_tags($e->get_error_message());
}

// bulk upgrades usually return false and leave the real error in the skin's messages
function wpch_last_error($skin) {
	if (method_exists($skin, 'get_errors')) { // not on every WP version; a fatal here would roll the site back
		foreach (array_reverse((array) $skin->get_errors()->get_error_messages()) as $m) return wp_strip_all_tags($m);
	}
	foreach (array_reverse((array) $skin->get_upgrade_messages()) as $m) {
		if (stripos($m, 'error') !== false || stripos($m, 'fail') !== false || stripos($m, 'not available') !== false) return wp_strip_all_tags($m);
	}
	return '';
}

function wpch_backup($args) {
	$only = isset($args['only']) ? array_map('strval', (array) $args['only']) : null;
	$updates = wpch_status()['updates'];
	// nightly / "update everything" runs leave premium updates alone
	if ($only === null) $only = array_column(array_filter($updates, fn($u) => empty($u['premium'])), 'id');
	$will_update = !empty($args['update']) && array_intersect(array_column($updates, 'id'), $only);
	// rollback after an update needs both database and files
	$scope = $will_update ? 'both' : (in_array($args['scope'] ?? '', ['db', 'files'], true) ? $args['scope'] : 'both');
	$zip = wpch_make_backup($scope);
	try {
		$file_id = wpch_upload($zip, $args['put_url']);
		wpch_report('backup', true, ['key' => $file_id, 'name' => $args['name'] ?? '', 'size' => filesize($zip), 'update' => (bool) $will_update, 'scope' => $scope]);
		if ($will_update) {
			try {
				wpch_report('update', true, wpch_update($zip, $only));
			} catch (Throwable $e) {
				wpch_restore_zip($zip); // updates half-applied: put the site back
				wpch_report('update', false, ['error' => $e->getMessage() . ' (site rolled back)']);
			}
		}
	} finally {
		@unlink($zip);
	}
}

function wpch_restore($args) {
	$zip = wpch_tmp('zip');
	try {
		// streamed from Google Drive through the hub; signed like reports (signed body = file id)
		$c  = wpch_conn();
		$id = (string) $args['key'];
		$ts = (string) time();
		$r  = wp_remote_get(rtrim($c['hub'], '/') . '/api/backup?file=' . rawurlencode($id), [
			'stream' => true, 'filename' => $zip, 'timeout' => 3600,
			'headers' => ['x-wpch-site' => $c['id'], 'x-wpch-ts' => $ts, 'x-wpch-sig' => wpch_sign($c['secret'], $ts, $id)],
		]);
		if (is_wp_error($r) || wp_remote_retrieve_response_code($r) !== 200) {
			throw new Exception('Backup download failed: ' . (is_wp_error($r) ? $r->get_error_message() : 'HTTP ' . wp_remote_retrieve_response_code($r)));
		}
		wpch_restore_zip($zip);
		wpch_report('restore', true, ['key' => $args['key']]);
	} finally {
		@unlink($zip);
	}
}

/* ---------- Self-update: install the connector zip the hub serves ---------- */

function wpch_self_update() {
	wpch_admin_includes();
	// the zip unpacks to wp-control-hub/; any other folder name would install a second copy
	if (dirname(plugin_basename(__FILE__)) !== 'wp-control-hub') {
		throw new Exception('Plugin folder is "' . dirname(plugin_basename(__FILE__)) . '", not "wp-control-hub": reinstall it once from the hub zip.');
	}
	$up = new Plugin_Upgrader(new Automatic_Upgrader_Skin());
	$r  = $up->install(rtrim(wpch_conn()['hub'], '/') . '/wp-control-hub.zip', ['overwrite_package' => true]);
	if (!$r || is_wp_error($r)) {
		throw new Exception('Connector update failed: ' . (is_wp_error($r) ? $r->get_error_message() : implode(' ', (array) $up->skin->get_upgrade_messages())));
	}
	if (function_exists('opcache_reset')) opcache_reset();
	wpch_report('connector', true, ['version' => get_file_data(__FILE__, ['v' => 'Version'])['v']]);
	wpch_report('status', true, wpch_status());
}

/* ---------- Users: add / delete from the hub ---------- */

function wpch_user($args) {
	wpch_admin_includes();
	$login = sanitize_user((string) ($args['login'] ?? ''), true);
	if ($login === '') throw new Exception('Username is required');

	if (($args['action'] ?? '') === 'add') {
		$email = sanitize_email((string) ($args['email'] ?? ''));
		$role  = (string) ($args['role'] ?? '');
		if (!is_email($email)) throw new Exception("Invalid email for $login");
		if (!get_role($role)) throw new Exception("Role \"$role\" does not exist on this site");
		// random password never leaves the site; WordPress emails the user a link to set their own
		$id = wp_insert_user(['user_login' => $login, 'user_email' => $email, 'role' => $role, 'user_pass' => wp_generate_password(32)]);
		if (is_wp_error($id)) throw new Exception($id->get_error_message());
		wp_new_user_notification($id, null, 'user');
		wpch_report('user', true, ['action' => 'add', 'login' => $login, 'role' => $role]);
	} elseif (($args['action'] ?? '') === 'delete') {
		$user = get_user_by('login', $login);
		if (!$user) throw new Exception("User $login not found");
		$admins = get_users(['role' => 'administrator', 'exclude' => [$user->ID], 'number' => 1, 'fields' => 'ID']);
		if (in_array('administrator', $user->roles, true) && !$admins) throw new Exception("$login is the last administrator; add another admin first");
		// their posts go to another admin instead of being deleted
		if (!wp_delete_user($user->ID, $admins ? (int) $admins[0] : null)) throw new Exception("Deleting $login failed");
		wpch_report('user', true, ['action' => 'delete', 'login' => $login]);
	} else {
		throw new Exception('Unknown user action');
	}
	wpch_report('status', true, wpch_status());
}

/* ---------- Site settings: debug mode (wp-config.php) and maintenance mode ---------- */

// args: maintenance / debug / debug_log => bool
function wpch_settings($args) {
	$set = [];
	foreach (['maintenance', 'debug', 'debug_log'] as $k) if (isset($args[$k])) $set[$k] = (bool) $args[$k];
	if (isset($set['maintenance'])) update_option('wpch_maintenance', $set['maintenance'] ? 1 : 0);
	$config = [];
	// debug output never goes on the page for visitors; errors only reach wp-content/debug.log when the log is on
	if (isset($set['debug'])) $config += ['WP_DEBUG' => $set['debug'], 'WP_DEBUG_DISPLAY' => false];
	if (isset($set['debug_log'])) $config['WP_DEBUG_LOG'] = $set['debug_log'];
	if ($config) wpch_config_set($config);
	wpch_report('settings', true, $set);
	$status = wpch_status();
	foreach (['debug', 'debug_log'] as $k) if (isset($set[$k])) $status['info'][$k] = $set[$k]; // constants in memory are still the old values
	wpch_report('status', true, $status);
}

// same lookup WordPress itself uses: ABSPATH, or one folder up
function wpch_config_path() {
	if (file_exists(ABSPATH . 'wp-config.php')) return ABSPATH . 'wp-config.php';
	if (file_exists(dirname(ABSPATH) . '/wp-config.php')) return dirname(ABSPATH) . '/wp-config.php';
	throw new Exception('wp-config.php not found');
}

// Sets define()s in wp-config.php: replaces existing ones, else inserts before the "stop editing" line.
function wpch_config_set($consts) {
	$file = wpch_config_path();
	$src  = file_get_contents($file);
	if ($src === false || !is_writable($file)) throw new Exception('wp-config.php is not writable by PHP');
	foreach ($consts as $name => $value) {
		$line = "define( '$name', " . ($value ? 'true' : 'false') . ' );';
		$re   = '/define\s*\(\s*([\'"])' . $name . '\1\s*,\s*[^)]*\)\s*;/';
		if (preg_match($re, $src)) {
			$src = preg_replace($re, $line, $src, 1);
			continue;
		}
		$at = stripos($src, "/* That's all");
		if ($at === false && preg_match('/require_once\s*\(?\s*ABSPATH\s*\.\s*[\'"]wp-settings\.php/', $src, $m, PREG_OFFSET_CAPTURE)) $at = $m[0][1];
		if ($at === false) throw new Exception("Can't find where to add $name in wp-config.php");
		$src = substr_replace($src, "$line\n", $at, 0);
	}
	// write a temp file and rename over: a half-written wp-config.php would take the site down
	$tmp = $file . '.wpch-' . wp_generate_password(8, false);
	if (file_put_contents($tmp, $src) === false) throw new Exception('Could not write wp-config.php');
	@chmod($tmp, fileperms($file) & 0777);
	if (!rename($tmp, $file)) {
		@unlink($tmp);
		throw new Exception('Could not replace wp-config.php');
	}
	if (function_exists('opcache_invalidate')) opcache_invalidate($file, true);
}
