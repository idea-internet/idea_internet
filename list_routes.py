import re
s = open('src/routes/pages.ts', encoding='utf-8').read()
keys = re.findall(r'^  "(/[^"]*)":', s, re.M)
for k in keys:
    print(repr(k))
print("---index.ts routing---")
idx = open('src/index.ts', encoding='utf-8').read()
print(idx)
