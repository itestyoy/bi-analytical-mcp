{# Return the REAL physical columns of a model's relation via the adapter
   (adapter.get_columns_in_relation) — actual warehouse schema, not metadata.
   Logged as a single line "MCP_COLS:<json>" for the server to parse. #}
{% macro mcp_relation_columns(model_name) %}
  {% if execute %}
    {% set rel = ref(model_name) %}
    {% set cols = adapter.get_columns_in_relation(rel) %}
    {% set out = [] %}
    {% for c in cols %}
      {% do out.append({"name": c.name, "dtype": c.dtype}) %}
    {% endfor %}
    {{ log("MCP_COLS:" ~ tojson(out), info=True) }}
  {% endif %}
{% endmacro %}
