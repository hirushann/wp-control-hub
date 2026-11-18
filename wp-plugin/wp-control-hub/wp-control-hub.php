<?php
/**
 * Plugin Name: WP Control Hub Connector
 * Description: Links this site to WP Control Hub: malware scans, admin account checks, Google Drive backups, updates with automatic rollback, remote restore.
 * Version: 0.2.0
 * Requires PHP: 7.4
 */

defined('ABSPATH') || exit;

define('WPCH_OPT', 'wpch_connection');
define('WPCH_DIR', WP_CONTENT_DIR . '/wpch-backups');

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
	if (!in_array($cmd, ['status', 'scan', 'backup', 'restore'], true)) {
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
	try {
		switch ($cmd) {
			case 'status':  wpch_report('status', true, wpch_status()); break;
			case 'scan':    wpch_report('scan', true, wpch_scan()); break;
			case 'backup':  wpch_backup($args); break;
			case 'restore': wpch_restore($args); break;
		}
	} catch (Throwable $e) {
		wpch_report($cmd, false, ['error' => $e->getMessage()]);
	}
}

/* ---------- Status: admin accounts + pending updates ---------- */

function wpch_admin_includes() {
	foreach (['update', 'plugin', 'theme', 'file', 'misc', 'class-wp-upgrader'] as $f) {
		require_once ABSPATH . "wp-admin/includes/$f.php";
	}
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
		$updates[] = ['id' => $file, 'type' => 'plugin', 'name' => $p->Name, 'from' => $p->Version, 'to' => $p->update->new_version];
	}
	foreach (get_theme_updates() as $slug => $t) {
		$updates[] = ['id' => $slug, 'type' => 'theme', 'name' => $t->get('Name'), 'from' => $t->get('Version'), 'to' => $t->update['new_version']];
	}
	$core = get_core_updates();
	if ($core && $core[0]->response === 'upgrade') {
		$updates[] = ['id' => 'core', 'type' => 'core', 'name' => 'WordPress', 'from' => get_bloginfo('version'), 'to' => $core[0]->current];
	}

	$admins = array_map(function ($u) {
		return ['login' => $u->user_login, 'email' => $u->user_email];
	}, get_users(['role' => 'administrator']));

	return ['wp' => get_bloginfo('version'), 'php' => PHP_VERSION, 'admins' => $admins, 'updates' => $updates, 'login_url' => wp_login_url()];
}

/* ---------- Malware scan ---------- */

function wpch_files($dir) {
	if (!is_dir($dir)) return;
	$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS));
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
function wpch_make_backup() {
	$sql = wpch_tmp('sql');
	$zipfile = wpch_tmp('zip');
	wpch_dump_db($sql);
	$zip = new ZipArchive();
	if ($zip->open($zipfile, ZipArchive::CREATE) !== true) throw new Exception('Cannot create zip');
	$zip->addFile($sql, 'wpch-db.sql');
	foreach (wpch_files(ABSPATH) as $path) {
		if (strpos($path, WPCH_DIR) === 0 || strpos($path, WP_CONTENT_DIR . '/cache/') === 0) continue;
		$zip->addFile($path, substr($path, strlen(ABSPATH)));
	}
	$ok = $zip->close();
	unlink($sql);
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

function wpch_restore_zip($zipfile) {
	$zip = new ZipArchive();
	if ($zip->open($zipfile) !== true) throw new Exception('Cannot open backup zip');

	// Database first, with a safety dump so a failed import doesn't leave a half-restored DB
	$sql    = wpch_tmp('sql');
	$safety = wpch_tmp('sql');
	try {
		if (!copy("zip://$zipfile#wpch-db.sql", $sql)) throw new Exception('Backup has no database dump');
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

	$names = [];
	for ($i = 0; $i < $zip->numFiles; $i++) {
		$n = $zip->getNameIndex($i);
		if ($n !== 'wpch-db.sql' && strpos($n, '..') === false) $names[] = $n;
	}
	// shortcut: overwrites files but doesn't delete ones added after the backup (e.g. new plugin files)
	if (!$zip->extractTo(ABSPATH, $names)) throw new Exception('Extracting files failed');
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
	$collect = function ($results) use (&$updated, &$failed) {
		foreach ((array) $results as $item => $r) {
			if ($r && !is_wp_error($r)) $updated[] = $item; else $failed[] = $item;
		}
	};
	if ($plugins = $pick(array_keys(get_plugin_updates()))) $collect((new Plugin_Upgrader($skin))->bulk_upgrade($plugins));
	if ($themes = $pick(array_keys(get_theme_updates()))) $collect((new Theme_Upgrader($skin))->bulk_upgrade($themes));
	$core = get_core_updates();
	if ($core && $core[0]->response === 'upgrade' && $pick(['core'])) $collect(['core' => (new Core_Upgrader($skin))->upgrade($core[0])]);

	if ($problem = wpch_health_problem()) {
		wpch_restore_zip($zipfile);
		return ['updated' => $updated, 'failed' => $failed, 'rolled_back' => true, 'reason' => $problem];
	}
	return ['updated' => $updated, 'failed' => $failed, 'rolled_back' => false];
}

function wpch_backup($args) {
	$only = isset($args['only']) ? array_map('strval', (array) $args['only']) : null;
	$ids  = array_column(wpch_status()['updates'], 'id');
	$will_update = !empty($args['update']) && ($only === null ? $ids : array_intersect($ids, $only));
	$zip = wpch_make_backup();
	try {
		$file_id = wpch_upload($zip, $args['put_url']);
		wpch_report('backup', true, ['key' => $file_id, 'name' => $args['name'] ?? '', 'size' => filesize($zip), 'update' => (bool) $will_update]);
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
