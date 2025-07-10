import re

text = """
- [ ] 標
- [ ] 反対
- [ ] 許
- [ ] 同棲
- [ ] 婚
- [ ] 是非
- [ ] 挨拶
- [ ] 温泉
- [ ] 素敵
- [ ] 聴く
- [ ] 街
- [ ] 天
"""

kanji = re.findall(r'[\u4e00-\u9fff]', text)
unique_kanji = list(dict.fromkeys(kanji))
query = "deck:漢字 " + " OR ".join(f"kanji:{k}" for k in unique_kanji)
print(query)
