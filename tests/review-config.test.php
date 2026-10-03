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
} finally {
    unlink($file);
    rmdir($root . '/private');
    rmdir($root);
}
echo "review token configuration passed\n";
