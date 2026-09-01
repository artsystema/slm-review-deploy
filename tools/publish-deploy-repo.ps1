[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$RepositoryUrl
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path

& git -C $repositoryRoot diff-index --quiet HEAD --
if ($LASTEXITCODE -ne 0) {
    throw 'Commit or stash tracked changes before publishing the deployment repository.'
}

$deployCommit = (& git -C $repositoryRoot subtree split --prefix=remote-review HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $deployCommit -notmatch '^[0-9a-f]{40}$') {
    throw 'Could not build the remote-review deployment history.'
}

& git -C $repositoryRoot push $RepositoryUrl "${deployCommit}:refs/heads/main"
if ($LASTEXITCODE -ne 0) {
    throw 'Could not push the deployment repository.'
}

Write-Output "Published remote-review commit $deployCommit to $RepositoryUrl"
