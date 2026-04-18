import pathlib
import textwrap

content = open(r"D:\claudeantasy nba	ests\_o2_content.txt", encoding="utf-8").read()
p = pathlib.Path(r"D:\claudeantasy nba	ests\ITER3_O2.md")
p.write_text(content, encoding="utf-8")
print("Written:", p)
