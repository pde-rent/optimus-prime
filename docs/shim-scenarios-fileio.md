# Shim scenario census: file IO + text processing

Living census (mission rule: extend, dedupe, never lose rows). GAP = no native surface yet.

| # | task phrasing | typical bash | python equivalent | our surface | notes |
|---|---|---|---|---|---|
| 1 | read a file | cat f | open(f).read() | read_file | |
| 2 | read first N lines | head -n f | f.readlines()[:N] | head | |
| 3 | read last N lines | tail -n f | f.readlines()[-N:] | tail | tail -f GAP (no follow) |
| 4 | search file contents | grep -rn pat | re.finditer | grep tool | rg alias maps here |
| 5 | search + context lines | grep -A3 -B3 | - | grep (context GAP - add -A/-B/-C) | |
| 6 | replace in file (dry) | sed 's/a/b/g' f | content.replace | sed tool (dry-run default) | |
| 7 | replace in file (apply) | sed -i | write back | sed tool apply=true | |
| 8 | count lines/words | wc -l/-w/-c | len(splitlines()) | wc tool | |
| 9 | count matches | grep -c | sum(1 for ...) | grep (count GAP - add count op) | |
| 10 | find files by name | find . -name | pathlib.glob | find tool | |
| 11 | find by size/mtime | find -size -mtime | os.stat filter | find tool (size/mtime params exist) | |
| 12 | list directory | ls -la | os.listdir+stat | GAP - add ls op to find or new tool | top-10 GAP |
| 13 | tree view | tree -L 2 | walk+print | find (tree render GAP) | |
| 14 | create dir | mkdir -p | os.makedirs | GAP (bash shim builtin via Bun.mkdirSync) | |
| 15 | copy file/tree | cp -r | shutil.copytree | GAP | |
| 16 | move/rename | mv | shutil.move | GAP | |
| 17 | delete | rm -rf | shutil.rmtree | GAP (guard: confirm flag) | |
| 18 | touch/empty file | touch f | Path(f).touch() | GAP | |
| 19 | write file | echo x > f | open(f,'w').write() | write_file | |
| 20 | append to file | echo x >> f | open(f,'a').write() | GAP (append op) | |
| 21 | file permissions | chmod | os.chmod | GAP | |
| 22 | symlink | ln -s | os.symlink | ln tool | |
| 23 | file size | du -sh / stat -c%s | os.path.getsize | sysinfo (disk) / stat GAP per-file | |
| 24 | compare files | diff a b | difflib | edit-diff generateDiffString | |
| 25 | apply patch | patch < p | - | GAP | |
| 26 | archive tar.gz | tar czf | tarfile | GAP | |
| 27 | zip | zip/unzip | zipfile | GAP (extract-zip was removed - Bun has unzip spawn) | |
| 28 | sort lines | sort | sorted(lines) | GAP (kernel builtin sort) | |
| 29 | unique lines | sort -u / uniq | set(lines) | GAP (kernel builtin) | |
| 30 | cut columns | cut -d, -f1 | csv/split | GAP (kernel builtin) | |
| 31 | translate chars | tr | str.translate | GAP | |
| 32 | columnize/pretty print | column -t | tabulate | df.toString | |
| 33 | line numbers | cat -n / nl | enumerate | read_file lineNumbers | |
| 34 | reverse lines | tac | lines[::-1] | GAP (kernel) | |
| 35 | join files | cat a b > c | concat | write_file + read | |
| 36 | split file | split | chunks | GAP | |
| 37 | watch file | tail -f | - | GAP (out of scope v1) | |
| 38 | which binary | which git | shutil.which | GAP (kernel: Bun.which) | |
| 39 | md5/sha of file | md5sum/sha256sum | hashlib | GAP (Bun.CryptoHasher) | |
| 40 | base64 encode/decode | base64 | b64encode | GAP (Bun native) | |
| 41 | edit interactively | vim/nano | - | edit tool (n/a - agents use edit) | |
| 42 | multiline insert | sed -i '/x/a ...' | insert at index | edit.patch (after:n) | |
| 43 | delete matching lines | sed -i '/pat/d' | filter | sed+edit | |
| 44 | numbered output in pipe | grep -n | nl | enumerate | grep lineNumbers | |
| 45 | case transform | tr '[:upper:]' '[:lower:]' | .lower() | GAP (kernel) | |
| 46 | word frequency | sort | uniq -c | Counter | kernel pipeline (sort+uniq+wc) | |
| 47 | empty dir cleanup | find -empty -delete | - | find + rm GAP combo | |
| 48 | newest file in dir | ls -t | head -1 | max(mtime) | GAP (kernel) | |
| 49 | disk usage of dir | du -sh /* | os.walk sizes | sysinfo du GAP | |
| 50 | read with line range | sed -n '5,10p' | lines[4:10] | read_file offset/limit | |
| 51 | pipe grep->wc | grep pat | wc -l | sum | shim pipe (grep+wc natives) | |
| 52 | pipe sort->head | sort | head | sorted[:N] | shim pipe | |
| 53 | here-doc write | cat <<EOF > f | - | write_file (heredoc parse) | |
| 54 | xargs apply | xargs cmd | loop | shim pipe (limited) | |
| 55 | stat metadata | stat f | os.stat | GAP (mode/uid/atime) | |
| 56 | temp file/dir | mktemp | tempfile | GAP (kernel Bun.tmp) | |
| 57 | read env var in pipe | echo $VAR | os.environ | kernel env bridge | |
| 58 | checksum compare files | cmp | filecmp | GAP | |
| 59 | split by pattern | csplit | - | GAP (rare) | |
| 60 | format json/yaml | jq / yq | json.dumps(indent) | GAP (jq is top-10 - add via kernel JSON) | jq = top-10 GAP |
