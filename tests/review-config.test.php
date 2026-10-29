<?php

declare(strict_types=1);

require dirname(__DIR__) . '/app/Config.php';

use SlmReview\Config;

$root = sys_get_temp_dir() . '/slm-review-config-' . bin2hex(random_bytes(6));
mkdir($root . '/private', 0700, true);
$file = $root . '/private/config.php';
$values = [
    'database' => ['host' => 'localhost', 'port' => 3306, 'name' => 'test', 'username' => 'test', 'password' => 'test'],
    'storage_dir' => $root,
    'ingest_token' => str_repeat('i', 32),
    'max_manifest_bytes' => 1024,
    'max_media_bytes' => 1024,
];
try {
    file_put_contents($file, '<?php return ' . var_export($values, true) . ';');
    $default = Config::load($root)->reviewToken();
    $clientSource = file_get_contents(dirname(__DIR__) . '/public/assets/review-default-token.js');
    if (!is_string($default) || preg_match('/^[0-9a-f]{64}$/D', $default) !== 1
        || !is_string($clientSource)
        || preg_match("/DEFAULT_REVIEW_TOKEN = '([0-9a-f]{64})'/", $clientSource, $matches) !== 1
        || $matches[1] !== $default) {
        throw new RuntimeException('server and browser review defaults differ');
    }
    if (Config::load($root)->sessionDeleteToken() !== null) {
        throw new RuntimeException('session deletion was enabled without a private token');
    }
    $values['review_token'] = 'short';
    file_put_contents($file, '<?php return ' . var_export($values, true) . ';');
    try {
        Config::load($root);
        throw new RuntimeException('short review token was accepted');
    } catch (RuntimeException $error) {
        if ($error->getMessage() !== 'review_token must be a long random secret') {
            throw $error;
        }
    }
    $values['review_token'] = 'replace-with-a-different-long-random-review-token';
    file_put_contents($file, '<?php return ' . var_export($values, true) . ';');
    if (Config::load($root)->reviewToken() !== $default) {
        throw new RuntimeException('example placeholder did not use the built-in review default');
    }
    $values['review_token'] = str_repeat('r', 64);
    file_put_contents($file, '<?php return ' . var_export($values, true) . ';');
    if (Config::load($root)->reviewToken() !== $values['review_token']) {
        throw new RuntimeException('configured review token was lost');
    }
    $values['session_delete_token'] = 'short';
    file_put_contents($file, '<?php return ' . var_export($values, true) . ';');
    try {
        Config::load($root);
        throw new RuntimeException('short session deletion token was accepted');
    } catch (RuntimeException $error) {
        if ($error->getMessage() !== 'session_delete_token must be a long random secret or null') {
            throw $error;
        }
    }
    $values['session_delete_token'] = str_repeat('d', 64);
    file_put_contents($file, '<?php return ' . var_export($values, true) . ';');
    if (Config::load($root)->sessionDeleteToken() !== $values['session_delete_token']) {
        throw new RuntimeException('configured session deletion token was lost');
    }
    $values['chamber_stream_url'] = 'https://live.example.com/chamber/player.html';
    file_put_contents($file, '<?php return ' . var_export($values, true) . ';');
    if (Config::load($root)->chamberStreamUrl() !== $values['chamber_stream_url']) {
        throw new RuntimeException('chamber stream player URL was lost');
    }
    $values['chamber_access_secret'] = 'short';
    file_put_contents($file, '<?php return ' . var_export($values, true) . ';');
    try {
        Config::load($root);
        throw new RuntimeException('short chamber access secret was accepted');
    } catch (RuntimeException $error) {
        if ($error->getMessage() !== 'chamber_access_secret must be a long random secret') {
            throw $error;
        }
    }
    $values['chamber_access_secret'] = str_repeat('v', 48);
    file_put_contents($file, '<?php return ' . var_export($values, true) . ';');
    if (Config::load($root)->chamberAccessSecret() !== $values['chamber_access_secret']) {
        throw new RuntimeException('chamber access secret was lost');
    }
    foreach (['http://live.example.com/chamber', 'https://user:pass@live.example.com/chamber',
        'https://live.example.com/chamber?token=secret', 'https://live.example.com/../private'] as $bad) {
        $values['chamber_stream_url'] = $bad;
        file_put_contents($file, '<?php return ' . var_export($values, true) . ';');
        try {
            Config::load($root);
            throw new RuntimeException("unsafe chamber URL accepted: {$bad}");
        } catch (RuntimeException $error) {
            if ($error->getMessage() !== 'chamber_stream_url must be a credential-free HTTPS player URL') {
                throw $error;
            }
        }
    }
} finally {
    unlink($file);
    rmdir($root . '/private');
    rmdir($root);
}
echo "review token configuration passed\n";
