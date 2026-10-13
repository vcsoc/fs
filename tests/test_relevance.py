import numpy as np
import pytest

from fs.core import Store


class WeakEmbedder:
    model = 'weak-model'

    def embed(self, texts, query=False):
        vector = [1, 0] if query else [0.42, (1 - 0.42 ** 2) ** .5]
        return np.asarray([vector for _ in texts], dtype=np.float32)


def test_best_unrelated_candidate_is_not_100_percent(tmp_path):
    root = tmp_path / 'files'
    root.mkdir()
    (root / 'irrelevant.txt').write_text('A family benefits document without cryptocurrency information.')
    store = Store(tmp_path / 'db', WeakEmbedder())
    store.index(root)
    broad = store.search('btc', minimum_relevance=0, mode='hybrid')
    assert broad['results'][0]['relevance'] == 42.0
    assert broad['results'][0]['relevance_basis'] == 'semantic'
    assert store.search('btc', minimum_relevance=.75, mode='hybrid')['total'] == 0
    assert store.search('btc', minimum_relevance=.75, mode='semantic')['total'] == 0
    assert store.search('btc', minimum_relevance=.4, mode='semantic')['total'] == 1


def test_exact_keyword_matches_are_distinct_from_semantic_similarity(tmp_path):
    root = tmp_path / 'files'
    root.mkdir()
    (root / 'wallet.txt').write_text('Store the BTC account recovery information offline.')
    store = Store(tmp_path / 'db', WeakEmbedder())
    store.index(root)
    result = store.search('btc', minimum_relevance=.75, mode='hybrid')['results'][0]
    assert result['relevance_basis'] == 'literal'
    assert result['semantic_similarity'] == .42
    assert 'Exact' in result['relevance_type']
    assert store.search('btc', minimum_relevance=.75, mode='semantic')['total'] == 0
    for value in [-1, 2, float('nan')]:
        with pytest.raises(ValueError):
            store.search('btc', minimum_relevance=value)
