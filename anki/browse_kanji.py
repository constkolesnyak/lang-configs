import re

text = """

"""

kanji = re.findall(r'[\u4e00-\u9fff]', text)
unique_kanji = list(dict.fromkeys(kanji))
query = "deck:漢字 " + " OR ".join(f"kanji:{k}" for k in unique_kanji)
print(query)
