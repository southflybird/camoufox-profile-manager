param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^v\d+\.\d+\.\d+$')]
    [string]$Version
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Git {
    param([string[]]$GitArguments)
    & git @GitArguments
    if ($LASTEXITCODE -ne 0) { throw "git $($GitArguments -join ' ') failed. Inspect the result before continuing." }
}

Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    $changes = & git status --porcelain
    if ($LASTEXITCODE -ne 0 -or $changes) { throw 'Commit or stash all local changes before synchronizing.' }
    $origin = & git remote get-url origin
    $upstream = & git remote get-url upstream
    if ($origin -ne 'https://github.com/southflybird/camoufox-profile-manager.git' -or $upstream -ne 'https://github.com/polyackiy/camoufox-profile-manager.git') {
        throw 'Unexpected origin/upstream. Check remote configuration first.'
    }
    $branch = "sync/upstream-$Version"
    & git show-ref --verify --quiet "refs/heads/$branch"
    if ($LASTEXITCODE -eq 0) { throw "$branch already exists; inspect it rather than overwriting it." }
    Invoke-Git -GitArguments @('fetch', '--no-tags', 'upstream', 'main')
    Invoke-Git -GitArguments @('fetch', '--no-tags', 'upstream', "refs/tags/${Version}:refs/tags/$Version")
    Invoke-Git -GitArguments @('fetch', '--no-tags', 'origin', 'custom')
    Invoke-Git -GitArguments @('switch', 'main')
    Invoke-Git -GitArguments @('merge', '--ff-only', 'upstream/main')
    Invoke-Git -GitArguments @('push', 'origin', 'main')
    Invoke-Git -GitArguments @('switch', 'custom')
    Invoke-Git -GitArguments @('merge', '--ff-only', 'origin/custom')
    & git merge-base --is-ancestor $Version HEAD
    if ($LASTEXITCODE -eq 0) { Write-Output "$Version is already included in custom."; return }
    Invoke-Git -GitArguments @('switch', '-c', $branch)
    Invoke-Git -GitArguments @('merge', '--no-ff', $Version, '-m', "Merge upstream $Version into custom")
    Write-Output "Review and test $branch. Push it and open a PR targeting southflybird:custom. Preserve its merge history."
} finally { Pop-Location }
