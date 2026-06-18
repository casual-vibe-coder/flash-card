// 64 units across the four levels of Al-ʿArabiyyah Bayna Yadayk.
// Book 1 unit titles are verified against published outlines; Books 2–4 use the
// standard themes (titles vary slightly between printings). Each unit is [arabic, english].
// You can replace or extend this list freely — the app renders whatever you pass in.

export const BOOKS = [
  { n: 1, name: "Book 1 · Foundations", units: [
    ["التحية والتعارف", "Greetings & introductions"], ["الأسرة", "The family"],
    ["السكن", "Housing"], ["الحياة اليومية", "Daily life"],
    ["الطعام والشراب", "Food & drink"], ["الصلاة", "Prayer (Salah)"],
    ["الدراسة", "Study"], ["العمل", "Work"],
    ["التسوق", "Shopping"], ["الجو", "Weather"],
    ["الناس والأماكن", "People & places"], ["الهوايات", "Hobbies"],
    ["السفر", "Travel"], ["الحج والعمرة", "Hajj & Umrah"],
    ["الصحة", "Health"], ["الإجازة", "Holiday / vacation"],
  ]},
  { n: 2, name: "Book 2 · Social & civic life", units: [
    ["العناية بالصحة", "Health care"], ["الطعام والضيافة", "Food & hospitality"],
    ["السفر والسياحة", "Travel & tourism"], ["المدن والأماكن", "Cities & places"],
    ["العلم والتعلم", "Knowledge & study"], ["المهن والأعمال", "Professions"],
    ["السفر لطلب العلم", "Travel for study"], ["الجوائز", "Prizes & awards"],
    ["وسائل الاتصال", "Communication"], ["الإعلام", "Media"],
    ["الأسواق", "Markets & shopping"], ["البيئة", "Environment"],
    ["الزراعة", "Agriculture"], ["الرياضة", "Sports"],
    ["العادات والتقاليد", "Customs & traditions"], ["المناسبات", "Occasions & events"],
  ]},
  { n: 3, name: "Book 3 · Society, science & culture", units: [
    ["الأسرة والمجتمع", "Family & society"], ["العمل والمهن", "Work & careers"],
    ["الصحة والطب", "Health & medicine"], ["العلم والعلماء", "Knowledge & scholars"],
    ["التقنية والحاسوب", "Technology & computing"], ["الاقتصاد والمال", "Economy & finance"],
    ["الإعلام والصحافة", "Media & press"], ["السياحة والآثار", "Tourism & heritage"],
    ["البيئة والطبيعة", "Environment & nature"], ["الفنون", "Arts"],
    ["التاريخ", "History"], ["الحضارة الإسلامية", "Islamic civilization"],
    ["الأدب والشعر", "Literature & poetry"], ["المرأة والأسرة", "Women & family"],
    ["التعليم", "Education"], ["القضايا الاجتماعية", "Social issues"],
  ]},
  { n: 4, name: "Book 4 · Advanced & abstract", units: [
    ["اللغة العربية", "The Arabic language"], ["الحضارات", "Civilizations"],
    ["العلوم والاكتشافات", "Science & discovery"], ["الأدب العربي", "Arabic literature"],
    ["الإعلام والاتصال", "Media & communication"], ["الاقتصاد العالمي", "Global economy"],
    ["السياسة والمجتمع", "Politics & society"], ["البيئة والتنمية", "Environment & development"],
    ["الفكر والثقافة", "Thought & culture"], ["الصحة العالمية", "Global health"],
    ["التقنية الحديثة", "Modern technology"], ["حقوق الإنسان", "Human rights"],
    ["التراث", "Heritage"], ["قضايا معاصرة", "Contemporary issues"],
    ["الحوار بين الثقافات", "Intercultural dialogue"], ["مستقبل العالم", "The future / global outlook"],
  ]},
];
